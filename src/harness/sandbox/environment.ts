import { aggregate } from "../../aggregate.js";
import { posix } from "node:path";
import type { CheckResult, Contract, GateReport } from "../../types.js";
import type {
  EnvironmentTaskInput,
  RunEnvironment,
} from "../run.js";
import { runWithCommandHeartbeat } from "../command-heartbeat.js";
import { tailClaudeStreamDuring } from "../claude-stream.js";
import {
  isHostLocalContract,
  runHostLocalGate,
} from "../host-gate.js";
import {
  claudeObservabilityVolumeSubpath,
  mountedClaudeObservabilityPaths,
  type DaytonaObservabilityConfig,
} from "../observability.js";
import {
  buildClaudeCommand,
  createDaytonaExecutionTarget,
  getClaudeEnvironment,
  parseClaudeSessionId,
} from "./daytona.js";
import { publishCandidate } from "./publish.js";
import type {
  CandidateSnapshot,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  WorkspaceFile,
} from "./types.js";
import {
  agentVisibleFiles,
  captureWorkspace,
  collectCandidate,
} from "./workspace.js";
import {
  assertClaudeToolchain,
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  getGateSnapshot,
  requireAgentSnapshot,
} from "./toolchain.js";

const REMOTE_ROOT = "/workspace/candidate";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

export type SandboxAgentSpec =
  | { kind: "claude" }
  | { kind: "command"; command: string };

export interface DaytonaRunObservabilityOptions {
  runId: string;
  config: DaytonaObservabilityConfig;
}

export interface DaytonaRunEnvironmentOptions {
  provider: SandboxProvider;
  root: string;
  policy: SandboxPolicy;
  agent: SandboxAgentSpec;
  environment?: Record<string, string | undefined>;
  observability?: DaytonaRunObservabilityOptions;
  onObservation?: (event: string, data: unknown) => void;
  heartbeatIntervalMs?: number;
}

interface PreparedClaudeObservability {
  env: Record<string, string>;
  claudeConfigDir?: string;
}

function integrityReport(reason: string): GateReport {
  const result: CheckResult = {
    id: "harness.candidate-integrity",
    type: "harness",
    status: "error",
    durationMs: 0,
    violations: [],
    errorReason: reason,
  };
  return aggregate([result]);
}

function commandFailure(label: string, result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): Error {
  return new Error(
    `${label} failed with exit ${result.exitCode}: ${
      result.stderr || result.stdout || "(no output)"
    }`,
  );
}

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoopbackHost(value: string): boolean {
  return value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value.endsWith(".localhost");
}

function urlUsesLoopback(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function contractUsesLoopbackHttp(contract: Contract): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) {
    return false;
  }
  const { url, baseUrl } = contract.trigger;
  return (typeof url === "string" && urlUsesLoopback(url)) ||
    (typeof baseUrl === "string" && urlUsesLoopback(baseUrl));
}

function validateHeartbeatIntervalMs(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "heartbeatIntervalMs must be a positive safe integer when provided",
    );
  }
}

function shouldBlockGateNetwork(contracts: Contract[]): boolean {
  return !contracts.some(contractUsesLoopbackHttp);
}

async function runSetup(
  handle: SandboxHandle,
  commands: string[],
  label: string,
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const result = await handle.execute(
      command,
      REMOTE_ROOT,
      {},
      SETUP_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw commandFailure(`${label} command ${index + 1}`, result);
    }
  }
}

async function prepareClaudeObservability(
  handle: SandboxHandle,
  runId: string,
  attempt: number,
  config: DaytonaObservabilityConfig,
  observe: (event: string, data: unknown) => void,
): Promise<PreparedClaudeObservability> {
  if (!config.enabled) return { env: {} };
  const paths = mountedClaudeObservabilityPaths(config, attempt);
  const env = {
    HARNESS_RUN_ID: runId,
    HARNESS_ATTEMPT: String(attempt),
    HARNESS_OBSERVABILITY_RUN_ROOT: paths.runRoot,
    HARNESS_OBSERVABILITY_ATTEMPT_ROOT: paths.attemptRoot,
    HARNESS_CLAUDE_STREAM_PATH: posix.join(
      paths.attemptRoot,
      "claude-stream.jsonl",
    ),
    HARNESS_CLAUDE_HOME_SNAPSHOT_DIR: posix.join(paths.runRoot, ".claude"),
  };
  observe("agent.observability.start", {
    id: handle.id,
    attempt,
    claudeConfigDir: paths.claudeConfigDir,
  });
  const startedAt = Date.now();
  let result;
  try {
    result = await handle.execute(
      'mkdir -p "$HARNESS_OBSERVABILITY_ATTEMPT_ROOT"',
      REMOTE_ROOT,
      env,
      30_000,
    );
  } catch (error) {
    observe("agent.observability.end", {
      id: handle.id,
      attempt,
      outcome: "error",
      durationMs: durationSince(startedAt),
    });
    throw error;
  }
  if (result.exitCode !== 0) {
    observe("agent.observability.end", {
      id: handle.id,
      attempt,
      outcome: "error",
      exitCode: result.exitCode,
      durationMs: durationSince(startedAt),
    });
    throw commandFailure("Claude observability setup", result);
  }
  observe("agent.observability.end", {
    id: handle.id,
    attempt,
    outcome: "ready",
    durationMs: durationSince(startedAt),
  });
  return {
    env,
    claudeConfigDir: paths.claudeConfigDir,
  };
}

const CLAUDE_HOME_SNAPSHOT_COMMAND =
  'if [ -d "$HOME/.claude" ]; then ' +
  'mkdir -p "$HARNESS_CLAUDE_HOME_SNAPSHOT_DIR" && ' +
  'cp -R "$HOME/.claude/." "$HARNESS_CLAUDE_HOME_SNAPSHOT_DIR/"; ' +
  "fi";

async function snapshotClaudeHome(
  handle: SandboxHandle,
  attempt: number,
  observationEnv: Record<string, string>,
  observe: (event: string, data: unknown) => void,
  failOnError: boolean,
): Promise<void> {
  const snapshotDir = observationEnv.HARNESS_CLAUDE_HOME_SNAPSHOT_DIR;
  if (!snapshotDir) return;

  observe("agent.observability.claude-home.start", {
    id: handle.id,
    attempt,
    path: snapshotDir,
  });
  const startedAt = Date.now();
  let result;
  try {
    result = await handle.execute(
      CLAUDE_HOME_SNAPSHOT_COMMAND,
      REMOTE_ROOT,
      { HARNESS_CLAUDE_HOME_SNAPSHOT_DIR: snapshotDir },
      60_000,
    );
  } catch (error) {
    observe("agent.observability.claude-home.end", {
      id: handle.id,
      attempt,
      path: snapshotDir,
      outcome: "error",
      errorReason: error instanceof Error ? error.message : String(error),
      durationMs: durationSince(startedAt),
    });
    if (failOnError) throw error;
    return;
  }
  if (result.exitCode !== 0) {
    observe("agent.observability.claude-home.end", {
      id: handle.id,
      attempt,
      path: snapshotDir,
      outcome: "error",
      exitCode: result.exitCode,
      durationMs: durationSince(startedAt),
    });
    if (failOnError) throw commandFailure("Claude home snapshot", result);
    return;
  }
  observe("agent.observability.claude-home.end", {
    id: handle.id,
    attempt,
    path: snapshotDir,
    outcome: "copied",
    durationMs: durationSince(startedAt),
  });
}

async function persistClaudeStreamOutput(
  sandboxId: string,
  attempt: number,
  stdout: string,
  observationEnv: Record<string, string>,
  observe: (event: string, data: unknown) => void,
): Promise<void> {
  const streamPath = observationEnv.HARNESS_CLAUDE_STREAM_PATH;
  if (!streamPath) return;

  const content = Buffer.from(stdout, "utf8");
  observe("agent.observability.stream", {
    id: sandboxId,
    attempt,
    path: streamPath,
    bytes: content.byteLength,
  });
}

export function createDaytonaRunEnvironment(
  options: DaytonaRunEnvironmentOptions,
): RunEnvironment {
  validateHeartbeatIntervalMs(options.heartbeatIntervalMs);
  const environment = options.environment ?? process.env;
  const baseline = captureWorkspace(options.root, options.policy);
  const modelEnvironment = options.agent.kind === "claude"
    ? getClaudeEnvironment(environment)
    : {};
  const agentSnapshot = options.agent.kind === "claude"
    ? requireAgentSnapshot(environment)
    : undefined;
  const gateSnapshot = getGateSnapshot(environment);
  const observability = options.agent.kind === "claude"
    ? options.observability
    : undefined;
  const observabilityVolumes = (() => {
    if (!observability?.config.enabled) return undefined;
    const observabilityVolumeSubpath = claudeObservabilityVolumeSubpath(
      observability.runId,
    );
    return [{
      volumeName: observability.config.volumeName,
      mountPath: observability.config.mountPath,
      subpath: observabilityVolumeSubpath,
    }];
  })();
  let agentHandle: SandboxHandle | undefined;
  let pendingCandidate: CandidateSnapshot | undefined;
  let approvedCandidate: CandidateSnapshot | undefined;
  let published = false;
  let closed = false;
  let agentAttempt = 0;
  let claudeSessionId: string | undefined;

  const observe = (event: string, data: unknown) => {
    options.onObservation?.(event, data);
  };

  const ensureAgent = async (): Promise<SandboxHandle> => {
    if (closed) throw new Error("Daytona run environment is closed");
    if (agentHandle) return agentHandle;
    observe("agent.create.start", {});
    const createStartedAt = Date.now();
    const handle = await options.provider.create({
      role: "agent",
      ...(agentSnapshot ? { snapshot: agentSnapshot } : {}),
      envVars: {},
      ephemeral: false,
      ...(observabilityVolumes ? { volumes: observabilityVolumes } : {}),
    });
    observe("agent.create.end", {
      id: handle.id,
      role: "agent",
      durationMs: durationSince(createStartedAt),
    });
    try {
      const agentFiles = agentVisibleFiles(baseline, options.policy);
      observe("agent.upload.start", { id: handle.id });
      const uploadStartedAt = Date.now();
      await handle.upload(
        agentFiles,
        REMOTE_ROOT,
      );
      observe("agent.upload.end", {
        id: handle.id,
        files: agentFiles.length,
        durationMs: durationSince(uploadStartedAt),
      });
      if (options.agent.kind === "claude") {
        observe("agent.preflight.start", { id: handle.id });
        const preflightStartedAt = Date.now();
        const preflight = await handle.execute(
          CLAUDE_TOOLCHAIN_PREFLIGHT,
          REMOTE_ROOT,
          {},
          30_000,
        );
        assertClaudeToolchain(preflight);
        observe("agent.preflight.end", {
          id: handle.id,
          exitCode: preflight.exitCode,
          durationMs: durationSince(preflightStartedAt),
        });
      }
      observe("agent.setup.start", { id: handle.id });
      const setupStartedAt = Date.now();
      await runSetup(handle, options.policy.agentSetup, "agent setup");
      observe("agent.setup.end", {
        id: handle.id,
        commands: options.policy.agentSetup.length,
        durationMs: durationSince(setupStartedAt),
      });
      agentHandle = handle;
      return handle;
    } catch (error) {
      await handle.delete().catch(() => undefined);
      throw error;
    }
  };

  return {
    name: `daytona(${options.agent.kind})`,

    async runTask(input: EnvironmentTaskInput) {
      const handle = await ensureAgent();
      agentAttempt++;
      const attempt = agentAttempt;
      let commandStartedAt = Date.now();
      let result;
      let commandStarted = false;
      let claudeObservationEnv: Record<string, string> = {};
      let claudeHomeSnapshotAttempted = false;
      try {
        if (options.agent.kind === "claude") {
          const resume = attempt > 1;
          if (resume && !claudeSessionId) {
            throw new Error(
              "Claude session id is required to resume a Daytona Claude attempt",
            );
          }
          const preparedObservability = observability
            ? await prepareClaudeObservability(
              handle,
              observability.runId,
              attempt,
              observability.config,
              observe,
            )
            : { env: {} };
          claudeObservationEnv = preparedObservability.env;
          const claudeConfigDir = preparedObservability.claudeConfigDir;
          commandStartedAt = Date.now();
          observe("agent.command.start", {
            id: handle.id,
            attempt,
            resume,
            ...(claudeSessionId ? { claudeSessionId } : {}),
            ...(claudeConfigDir ? { claudeConfigDir } : {}),
            ...(claudeObservationEnv.HARNESS_CLAUDE_STREAM_PATH
              ? {
                claudeStreamPath:
                  claudeObservationEnv.HARNESS_CLAUDE_STREAM_PATH,
              }
              : {}),
            ...(claudeObservationEnv.HARNESS_CLAUDE_HOME_SNAPSHOT_DIR
              ? {
                claudeHomeSnapshotDir:
                  claudeObservationEnv.HARNESS_CLAUDE_HOME_SNAPSHOT_DIR,
              }
              : {}),
          });
          commandStarted = true;
          const prompt = input.feedback
            ? `${input.task}\n\n[门禁反馈,请据此修复]\n${input.feedback}`
            : input.task;
          const command = buildClaudeCommand(
            resume ? "resume" : undefined,
          );
          const commandEnv = {
            ...modelEnvironment,
            ...claudeObservationEnv,
            HARNESS_PROMPT: prompt,
            ...(resume && claudeSessionId
              ? { HARNESS_CLAUDE_SESSION_ID: claudeSessionId }
              : {}),
          };
          const runClaudeCommand = () =>
            handle.execute(
              command,
              REMOTE_ROOT,
              commandEnv,
              AGENT_COMMAND_TIMEOUT_MS,
            );
          const streamPath = claudeObservationEnv.HARNESS_CLAUDE_STREAM_PATH;
          const runObservedClaudeCommand = () =>
            streamPath
              ? tailClaudeStreamDuring({
                id: handle.id,
                attempt,
                path: streamPath,
                read: (path) => handle.readFile(path),
                emit: ({ event, data }) => observe(event, data),
                run: runClaudeCommand,
                intervalMs: 50,
                noOutputWarningMs: 60_000,
              })
              : runClaudeCommand();
          result = await runWithCommandHeartbeat({
            id: handle.id,
            attempt,
            kind: "claude",
            streamPath,
            intervalMs: options.heartbeatIntervalMs,
            emit: ({ event, data }) => observe(event, data),
            run: runObservedClaudeCommand,
          });
          claudeHomeSnapshotAttempted = true;
          await snapshotClaudeHome(
            handle,
            attempt,
            claudeObservationEnv,
            observe,
            true,
          );
          await persistClaudeStreamOutput(
            handle.id,
            attempt,
            result.stdout,
            claudeObservationEnv,
            observe,
          );
          const parsedClaudeSessionId = parseClaudeSessionId(result.stdout);
          if (!parsedClaudeSessionId) {
            throw new Error(
              "Claude session id was not reported by the Daytona Claude command",
            );
          }
          if (
            claudeSessionId &&
            parsedClaudeSessionId !== claudeSessionId
          ) {
            throw new Error(
              `Claude session id changed from ${claudeSessionId} to ${parsedClaudeSessionId}`,
            );
          }
          claudeSessionId = parsedClaudeSessionId;
        } else {
          commandStartedAt = Date.now();
          observe("agent.command.start", { id: handle.id, attempt });
          commandStarted = true;
          result = await handle.runPty(
            options.agent.command,
            REMOTE_ROOT,
            {
              HARNESS_TASK: input.task,
              HARNESS_FEEDBACK: input.feedback ?? "",
            },
          );
        }
      } catch (error) {
        if (
          options.agent.kind === "claude" &&
          !claudeHomeSnapshotAttempted
        ) {
          claudeHomeSnapshotAttempted = true;
          await snapshotClaudeHome(
            handle,
            attempt,
            claudeObservationEnv,
            observe,
            false,
          );
        }
        if (commandStarted) {
          observe("agent.command.end", {
            id: handle.id,
            attempt,
            outcome: "error",
            errorReason: error instanceof Error ? error.message : String(error),
            durationMs: durationSince(commandStartedAt),
          });
        }
        throw error;
      }
      observe("agent.command.end", {
        id: handle.id,
        attempt,
        exitCode: result.exitCode,
        ...(options.agent.kind === "claude" && claudeSessionId
          ? { claudeSessionId }
          : {}),
        durationMs: durationSince(commandStartedAt),
      });
      return {
        summary: `sandbox agent exited ${result.exitCode}` +
          (result.stderr || result.stdout
            ? `: ${(result.stderr || result.stdout).trim().split("\n").at(-1)}`
            : ""),
        changedFiles: [],
      };
    },

    async runGate({ contracts, gate, ctx }) {
      const attempt = Math.max(agentAttempt, 1);
      approvedCandidate = undefined;
      const handle = await ensureAgent();
      try {
        observe("candidate.collect.start", { id: handle.id });
        const collectStartedAt = Date.now();
        pendingCandidate = await collectCandidate(
          handle.workspace(
            REMOTE_ROOT,
            Math.min(
              Number.MAX_SAFE_INTEGER,
              options.policy.limits.maxFiles * 2,
            ),
            [
              ...options.policy.candidateRoots,
              ...options.policy.protectedPaths,
            ],
          ),
          baseline,
          options.policy,
        );
        observe("candidate.collect.end", {
          id: handle.id,
          operations: pendingCandidate.operations.length,
          files: pendingCandidate.files.size,
          durationMs: durationSince(collectStartedAt),
        });
      } catch (error) {
        pendingCandidate = undefined;
        return integrityReport(
          error instanceof Error ? error.message : String(error),
        );
      }

      const hostContracts = contracts.filter(isHostLocalContract);
      const remoteContracts = contracts.filter((contract) =>
        !isHostLocalContract(contract)
      );
      const combinedResults: CheckResult[] = [];
      let gateHandle: SandboxHandle | undefined;
      let report: GateReport | undefined;
      let cleanupError: unknown;
      if (remoteContracts.length > 0) {
        try {
          observe("gate.create.start", { attempt });
          const gateCreateStartedAt = Date.now();
          gateHandle = await options.provider.create({
            role: "gate",
            snapshot: gateSnapshot,
            envVars: {},
            ephemeral: true,
          });
          observe("gate.create.end", {
            id: gateHandle.id,
            role: "gate",
            attempt,
            durationMs: durationSince(gateCreateStartedAt),
          });
          observe("gate.upload.start", { id: gateHandle.id });
          const initialUploadStartedAt = Date.now();
          await gateHandle.upload(
            [...baseline.files.values()],
            REMOTE_ROOT,
          );
          observe("gate.upload.end", {
            id: gateHandle.id,
            files: baseline.files.size,
            durationMs: durationSince(initialUploadStartedAt),
          });
          const mutableFiles = agentVisibleFiles(
            baseline,
            options.policy,
          );
          const baselineMutablePaths = mutableFiles.map((file) => file.path);
          observe("gate.upload.start", { id: gateHandle.id });
          const candidateUploadStartedAt = Date.now();
          await gateHandle.remove(baselineMutablePaths, REMOTE_ROOT);
          await gateHandle.upload(
            [...pendingCandidate.files.values()],
            REMOTE_ROOT,
          );
          const mutablePaths = new Set(mutableFiles.map((file) => file.path));
          const protectedFiles = [...baseline.files.values()].filter((file) =>
            !mutablePaths.has(file.path)
          );
          await gateHandle.upload(protectedFiles, REMOTE_ROOT);
          await gateHandle.verify(protectedFiles, REMOTE_ROOT);
          observe("gate.upload.end", {
            id: gateHandle.id,
            files: pendingCandidate.files.size + protectedFiles.length,
            removed: baselineMutablePaths.length,
            verified: protectedFiles.length,
            durationMs: durationSince(candidateUploadStartedAt),
          });
          observe("gate.setup.start", { id: gateHandle.id });
          const gateSetupStartedAt = Date.now();
          await runSetup(gateHandle, options.policy.gateSetup, "gate setup");
          observe("gate.setup.end", {
            id: gateHandle.id,
            commands: options.policy.gateSetup.length,
            durationMs: durationSince(gateSetupStartedAt),
          });
          const blockGateNetwork = shouldBlockGateNetwork(remoteContracts);
          observe("gate.network.start", { id: gateHandle.id });
          const networkStartedAt = Date.now();
          if (blockGateNetwork) {
            await gateHandle.setNetworkBlocked(true);
          }
          observe("gate.network.end", {
            id: gateHandle.id,
            blocked: blockGateNetwork,
            ...(!blockGateNetwork ? { reason: "loopback-http" } : {}),
            durationMs: durationSince(networkStartedAt),
          });
          observe("gate.run.start", { id: gateHandle.id, attempt });
          const gateRunStartedAt = Date.now();
          report = await gate.run(remoteContracts, {
            ...ctx,
            cwd: REMOTE_ROOT,
            execution: createDaytonaExecutionTarget(gateHandle, REMOTE_ROOT),
          });
          observe("gate.run.end", {
            id: gateHandle.id,
            attempt,
            outcome: report.outcome,
            results: report.results.length,
            durationMs: durationSince(gateRunStartedAt),
          });
          await gateHandle.verify(protectedFiles, REMOTE_ROOT);
          observe("gate.result", {
            id: gateHandle.id,
            outcome: report.outcome,
          });
        } catch (error) {
          report = integrityReport(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          if (gateHandle) {
            observe("gate.cleanup.start", { id: gateHandle.id, attempt });
            const cleanupStartedAt = Date.now();
            try {
              await gateHandle.delete();
              observe("gate.cleanup.end", {
                id: gateHandle.id,
                attempt,
                outcome: "deleted",
                durationMs: durationSince(cleanupStartedAt),
              });
            } catch (error) {
              cleanupError = error;
              observe("gate.cleanup.end", {
                id: gateHandle.id,
                attempt,
                outcome: "error",
                durationMs: durationSince(cleanupStartedAt),
              });
            }
          }
        }
      }

      if (!report && remoteContracts.length > 0) {
        return integrityReport("Gate did not produce a report");
      }
      if (report) combinedResults.push(...report.results);
      if (hostContracts.length > 0) {
        observe("host-gate.run.start", { contracts: hostContracts.length });
        const hostStartedAt = Date.now();
        try {
          const hostReport = await runHostLocalGate({
            contracts: hostContracts,
            gate,
            ctx,
            baseline,
            candidate: pendingCandidate,
            policy: options.policy,
          });
          combinedResults.push(...hostReport.results);
          observe("host-gate.run.end", {
            outcome: hostReport.outcome,
            results: hostReport.results.length,
            durationMs: durationSince(hostStartedAt),
          });
        } catch (error) {
          return integrityReport(
            `Host-local gate failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (cleanupError) {
        return integrityReport(
          `Gate sandbox cleanup failed: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
      const finalReport = aggregate(combinedResults);
      if (finalReport.outcome === "pass") approvedCandidate = pendingCandidate;
      return finalReport;
    },

    async publish() {
      const candidate = approvedCandidate;
      approvedCandidate = undefined;
      if (!candidate) {
        return {
          ok: false,
          changedFiles: [],
          conflict: "No gate-approved candidate is pending publication",
        };
      }
      const publication = publishCandidate(
        baseline,
        candidate,
        options.policy,
      );
      published = publication.ok;
      return publication;
    },

    async close() {
      if (closed) return;
      if (
        agentHandle &&
        (!options.policy.retainOnFailure || published)
      ) {
        observe("agent.cleanup.start", { id: agentHandle.id });
        const cleanupStartedAt = Date.now();
        await agentHandle.delete();
        observe("agent.cleanup.end", {
          id: agentHandle.id,
          outcome: "deleted",
          durationMs: durationSince(cleanupStartedAt),
        });
      }
      closed = true;
    },
  };
}

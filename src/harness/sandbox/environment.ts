import { aggregate } from "../../aggregate.js";
import type { CheckResult, GateReport } from "../../types.js";
import type {
  EnvironmentTaskInput,
  RunEnvironment,
} from "../run.js";
import {
  CLAUDE_COMMAND,
  createDaytonaExecutionTarget,
  getClaudeEnvironment,
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
  requireAgentSnapshot,
} from "./toolchain.js";

const REMOTE_ROOT = "/workspace/candidate";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export type SandboxAgentSpec =
  | { kind: "claude" }
  | { kind: "command"; command: string };

export interface DaytonaRunEnvironmentOptions {
  provider: SandboxProvider;
  root: string;
  policy: SandboxPolicy;
  agent: SandboxAgentSpec;
  environment?: Record<string, string | undefined>;
  onObservation?: (event: string, data: unknown) => void;
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

export function createDaytonaRunEnvironment(
  options: DaytonaRunEnvironmentOptions,
): RunEnvironment {
  const environment = options.environment ?? process.env;
  const baseline = captureWorkspace(options.root, options.policy);
  const modelEnvironment = options.agent.kind === "claude"
    ? getClaudeEnvironment(environment)
    : {};
  const agentSnapshot = options.agent.kind === "claude"
    ? requireAgentSnapshot(environment)
    : undefined;
  let agentHandle: SandboxHandle | undefined;
  let pendingCandidate: CandidateSnapshot | undefined;
  let approvedCandidate: CandidateSnapshot | undefined;
  let published = false;
  let closed = false;

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
      observe("agent.command.start", { id: handle.id });
      const commandStartedAt = Date.now();
      let result;
      if (options.agent.kind === "claude") {
        const prompt = input.feedback
          ? `${input.task}\n\n[门禁反馈,请据此修复]\n${input.feedback}`
          : input.task;
        result = await handle.runPty(
          CLAUDE_COMMAND,
          REMOTE_ROOT,
          { ...modelEnvironment, HARNESS_PROMPT: prompt },
        );
      } else {
        result = await handle.runPty(
          options.agent.command,
          REMOTE_ROOT,
          {
            HARNESS_TASK: input.task,
            HARNESS_FEEDBACK: input.feedback ?? "",
          },
        );
      }
      observe("agent.command.end", {
        id: handle.id,
        exitCode: result.exitCode,
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

      let gateHandle: SandboxHandle | undefined;
      let report: GateReport | undefined;
      let cleanupError: unknown;
      try {
        observe("gate.create.start", {});
        const gateCreateStartedAt = Date.now();
        gateHandle = await options.provider.create({
          role: "gate",
          envVars: {},
          ephemeral: true,
        });
        observe("gate.create.end", {
          id: gateHandle.id,
          role: "gate",
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
        observe("gate.setup.start", { id: gateHandle.id });
        const gateSetupStartedAt = Date.now();
        await runSetup(gateHandle, options.policy.gateSetup, "gate setup");
        observe("gate.setup.end", {
          id: gateHandle.id,
          commands: options.policy.gateSetup.length,
          durationMs: durationSince(gateSetupStartedAt),
        });
        const baselineMutablePaths = agentVisibleFiles(
          baseline,
          options.policy,
        ).map((file) => file.path);
        observe("gate.upload.start", { id: gateHandle.id });
        const candidateUploadStartedAt = Date.now();
        await gateHandle.remove(baselineMutablePaths, REMOTE_ROOT);
        await gateHandle.upload(
          [...pendingCandidate.files.values()],
          REMOTE_ROOT,
        );
        const protectedFiles = [...baseline.files.values()].filter((file) =>
          !agentVisibleFiles(baseline, options.policy)
            .some((mutable) => mutable.path === file.path)
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
        observe("gate.network.start", { id: gateHandle.id });
        const networkStartedAt = Date.now();
        await gateHandle.setNetworkBlocked(true);
        observe("gate.network.end", {
          id: gateHandle.id,
          blocked: true,
          durationMs: durationSince(networkStartedAt),
        });
        observe("gate.run.start", { id: gateHandle.id });
        const gateRunStartedAt = Date.now();
        report = await gate.run(contracts, {
          ...ctx,
          cwd: REMOTE_ROOT,
          execution: createDaytonaExecutionTarget(gateHandle, REMOTE_ROOT),
        });
        observe("gate.run.end", {
          id: gateHandle.id,
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
          observe("gate.cleanup.start", { id: gateHandle.id });
          const cleanupStartedAt = Date.now();
          try {
            await gateHandle.delete();
            observe("gate.cleanup.end", {
              id: gateHandle.id,
              outcome: "deleted",
              durationMs: durationSince(cleanupStartedAt),
            });
          } catch (error) {
            cleanupError = error;
            observe("gate.cleanup.end", {
              id: gateHandle.id,
              outcome: "error",
              durationMs: durationSince(cleanupStartedAt),
            });
          }
        }
      }

      if (!report) return integrityReport("Gate did not produce a report");
      if (cleanupError) {
        return integrityReport(
          `Gate sandbox cleanup failed: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
      if (report.outcome === "pass") approvedCandidate = pendingCandidate;
      return report;
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

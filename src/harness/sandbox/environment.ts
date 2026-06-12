import { aggregate } from "../../aggregate.js";
import type { CheckResult, GateReport } from "../../types.js";
import type {
  EnvironmentTaskInput,
  RunEnvironment,
} from "../run.js";
import {
  CLAUDE_COMMAND,
  CLAUDE_INSTALL_COMMAND,
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

const REMOTE_ROOT = "/workspace/candidate";

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

async function runSetup(
  handle: SandboxHandle,
  commands: string[],
  label: string,
): Promise<void> {
  for (const command of commands) {
    const result = await handle.runPty(command, REMOTE_ROOT, {});
    if (result.exitCode !== 0) throw commandFailure(label, result);
  }
}

export function createDaytonaRunEnvironment(
  options: DaytonaRunEnvironmentOptions,
): RunEnvironment {
  const baseline = captureWorkspace(options.root, options.policy);
  const modelEnvironment = options.agent.kind === "claude"
    ? getClaudeEnvironment(options.environment ?? process.env)
    : {};
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
    const handle = await options.provider.create({
      role: "agent",
      envVars: {},
      ephemeral: false,
    });
    try {
      await handle.upload(
        agentVisibleFiles(baseline, options.policy),
        REMOTE_ROOT,
      );
      await runSetup(handle, options.policy.agentSetup, "agent setup");
      if (options.agent.kind === "claude") {
        const installation = await handle.runPty(
          CLAUDE_INSTALL_COMMAND,
          REMOTE_ROOT,
          {},
        );
        if (installation.exitCode !== 0) {
          throw commandFailure("Claude Code installation", installation);
        }
      }
      agentHandle = handle;
      observe("agent.create.end", { id: handle.id });
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
        pendingCandidate = await collectCandidate(
          handle.workspace(
            REMOTE_ROOT,
            Math.min(
              Number.MAX_SAFE_INTEGER,
              options.policy.limits.maxFiles * 2,
            ),
          ),
          baseline,
          options.policy,
        );
        observe("candidate.collect.end", {
          operations: pendingCandidate.operations.length,
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
        gateHandle = await options.provider.create({
          role: "gate",
          envVars: {},
          ephemeral: true,
        });
        observe("gate.create.end", { id: gateHandle.id });
        await gateHandle.upload(
          [...baseline.files.values()],
          REMOTE_ROOT,
        );
        await runSetup(gateHandle, options.policy.gateSetup, "gate setup");
        const baselineMutablePaths = agentVisibleFiles(
          baseline,
          options.policy,
        ).map((file) => file.path);
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
        await gateHandle.setNetworkBlocked(true);
        report = await gate.run(contracts, {
          ...ctx,
          cwd: REMOTE_ROOT,
          execution: createDaytonaExecutionTarget(gateHandle, REMOTE_ROOT),
        });
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
          try {
            await gateHandle.delete();
            observe("gate.cleanup", { id: gateHandle.id });
          } catch (error) {
            cleanupError = error;
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
        await agentHandle.delete();
        observe("agent.cleanup", { id: agentHandle.id });
      }
      closed = true;
    },
  };
}

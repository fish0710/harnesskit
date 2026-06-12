import type { Contract, GateReport, RunContext } from "../types.js";
import type { GateCore } from "../gate.js";
import { decideEscalation, type EscalationAction, type LoopState } from "../agent/escalation.js";
import type {
  AgentDriver,
  AgentTaskInput,
  AgentTaskResult,
} from "./drivers.js";
import type { PublicationResult } from "./sandbox/publish.js";

export interface GenerationBudget {
  maxAttempts: number;
  maxTokens: number;
  maxMs: number;
  contextThreshold: number;
  repeatWallThreshold: number;
}

export interface RunOptions {
  task: string;
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  environment: RunEnvironment;
  budget: GenerationBudget;
  initialFeedback?: string;
  contextUsedRatio?: () => number;
  onLog?: (line: string) => void;
}

export type EnvironmentTaskInput = Omit<AgentTaskInput, "cwd">;

export interface RunEnvironment {
  readonly name: string;
  runTask(input: EnvironmentTaskInput): Promise<AgentTaskResult>;
  runGate(input: {
    contracts: Contract[];
    gate: GateCore;
    ctx: RunContext;
  }): Promise<GateReport>;
  publish(): Promise<PublicationResult>;
  close(): Promise<void>;
}

export function localRunEnvironment(
  driver: AgentDriver,
  cwd: string,
): RunEnvironment {
  return {
    name: driver.name,
    runTask(input) {
      return driver.runTask({ ...input, cwd });
    },
    runGate({ contracts, gate, ctx }) {
      return gate.run(contracts, ctx);
    },
    async publish() {
      return { ok: true, changedFiles: [] };
    },
    async close() {
      await driver.close?.();
    },
  };
}

export interface RunOutcome {
  outcome: "ready_for_mr" | "escalated" | "blocked";
  attempts: number;
  report: GateReport;
  action?: Exclude<EscalationAction, { kind: "continue" }>;
  logs: string[];
}

function diagnostics(report: GateReport): string {
  return report.results
    .filter((r) => r.status === "fail" || r.status === "error")
    .map((r) =>
      r.status === "error"
        ? `- [${r.id}] 没跑成: ${r.errorReason}`
        : r.violations.map((v) => `- [${r.id}] ${v.what} | 修复: ${v.how}`).join("\n"),
    )
    .join("\n");
}

function updateStreaks(state: LoopState, report: GateReport): void {
  for (const r of report.results) {
    if (r.status === "fail" || r.status === "error") {
      state.failStreakByCheck[r.id] = (state.failStreakByCheck[r.id] ?? 0) + 1;
    } else if (r.status === "pass") {
      state.failStreakByCheck[r.id] = 0;
    }
  }
}

/**
 * 产出循环:driver 改一次 → 跑内环门禁 → 通过则就绪开 MR;否则反馈重试或升级。
 *   pass    → ready_for_mr(绿≠放行,只代表“值得开 MR”;真正裁决在 CI)
 *   blocked → 立即返回(只有 needs_review,需人去 review,不该自动迭代)
 *   fail    → 据 escalation 继续/升级
 */
export async function runLoop(o: RunOptions): Promise<RunOutcome> {
  const logs: string[] = [];
  const log = (s: string) => {
    logs.push(s);
    o.onLog?.(s);
  };
  const state: LoopState = {
    attempts: 0,
    maxAttempts: o.budget.maxAttempts,
    tokensUsed: 0,
    maxTokens: o.budget.maxTokens,
    elapsedMs: 0,
    maxMs: o.budget.maxMs,
    contextUsedRatio: 0,
    contextThreshold: o.budget.contextThreshold,
    failStreakByCheck: {},
    repeatWallThreshold: o.budget.repeatWallThreshold,
  };
  const startedAt = performance.now();
  let feedback = o.initialFeedback ?? "";

  // 保底:防止意外死循环(在 escalation 之外再加一道硬上限)
  const hardCap = Math.max(o.budget.maxAttempts, 1);

  try {
    while (true) {
      state.attempts++;
      log(`第 ${state.attempts} 轮 · environment=${o.environment.name}`);
      const act = await o.environment.runTask({ task: o.task, feedback });
      log(`  driver: ${act.summary}`);

      const report = await o.environment.runGate({
        contracts: o.contracts,
        gate: o.gate,
        ctx: o.ctx,
      });
      log(`  门禁: ${report.outcome}(pass ${report.summary.pass}/${report.summary.total}, fail ${report.summary.fail}, error ${report.summary.error}, review ${report.summary.needsReview})`);

      if (report.outcome === "pass") {
        const publication = await o.environment.publish();
        if (!publication.ok) {
          const action = {
            kind: "stop_for_human" as const,
            reason: publication.conflict ?? "候选发布失败",
          };
          log(`  发布失败,升级: ${action.reason}`);
          return {
            outcome: "escalated",
            attempts: state.attempts,
            report,
            action,
            logs,
          };
        }
        log("  ✓ 就绪:可开 MR(注意:绿不算放行,合入裁决在 CI 隔离环境)");
        return { outcome: "ready_for_mr", attempts: state.attempts, report, logs };
      }
      if (report.outcome === "blocked") {
        log("  ◐ 有待人工决策项,停下 → 运行 `harness review`");
        return { outcome: "blocked", attempts: state.attempts, report, logs };
      }

      // fail：判断是否升级
      updateStreaks(state, report);
      state.elapsedMs = performance.now() - startedAt;
      state.contextUsedRatio = o.contextUsedRatio?.() ?? 0;
      const action = decideEscalation(state);
      if (action.kind !== "continue") {
        log(`  升级: ${action.kind} — ${action.reason}`);
        return { outcome: "escalated", attempts: state.attempts, report, action, logs };
      }
      if (state.attempts >= hardCap) {
        log(`  达到硬上限 ${hardCap} 轮,停下交人`);
        return { outcome: "escalated", attempts: state.attempts, report, action: { kind: "stop_for_human", reason: `达到硬上限 ${hardCap} 轮` }, logs };
      }

      feedback = diagnostics(report);
      log("  未通过 → 把诊断反馈给 driver,重试");
    }
  } finally {
    await o.environment.close();
  }
}

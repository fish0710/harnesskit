import {
  commandEvidenceError,
  executionId,
  localExecutionTarget,
} from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

/**
 * boot 插件：测量启动耗时是否 ≤ 阈值（启动 SLA）。
 *   起不来      → error
 *   起来但超时  → fail
 *   起来且达标  → pass
 *
 * 契约字段：{ cmd: string, args?: string[], expect: { startup_ms_lte: number } }
 * 说明：demo 里以“进程退出”近似“启动完成”；真实服务应等就绪信号(日志/健康检查)。
 */
export const bootPlugin: Plugin = {
  type: "boot",

  async run(contract: Contract, ctx: RunContext): Promise<CheckResult> {
    const cmd = String(contract.cmd ?? "");
    const args = Array.isArray(contract.args) ? contract.args.map(String) : [];
    const expect = (contract.expect ?? {}) as { startup_ms_lte?: number };
    const budget = typeof expect.startup_ms_lte === "number" ? expect.startup_ms_lte : 800;
    const timeoutMs = typeof contract.timeoutMs === "number" ? contract.timeoutMs : undefined;

    if (!cmd) {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "契约缺少 cmd 字段 ⇒ error" };
    }

    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: cmd,
      args,
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
    });
    const elapsed = evidence.durationMs;

    const evidenceError = commandEvidenceError(id, evidence);
    if (evidenceError) {
      return { id: contract.id, type: this.type, status: "error", durationMs: elapsed, violations: [],
        errorReason: `进程无法启动或执行证据不可信: ${evidenceError} ⇒ error` };
    }
    if (elapsed <= budget) {
      return { id: contract.id, type: this.type, status: "pass", durationMs: elapsed, violations: [] };
    }
    return {
      id: contract.id, type: this.type, status: "fail", durationMs: elapsed,
      violations: [
        {
          what: `启动耗时 ${elapsed.toFixed(0)}ms 超过 SLA ${budget}ms`,
          why: "启动慢会拖垮内环里的动态检查反馈",
          how: "定位启动期的同步初始化(大资源加载/阻塞 IO),改惰性或异步预热",
        },
      ],
    };
  },
};

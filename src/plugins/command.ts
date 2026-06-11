import { executionId, localExecutionTarget } from "../harness/execution.js";
import type { CalibrationResult, CheckResult, Contract, Plugin, RunContext } from "../types.js";

/**
 * command 插件：跑一个命令。
 *   退出码 0     → pass（跑了，通过）
 *   退出码 ≠ 0   → fail（跑了，发现问题）
 *   起不来/崩溃  → error（没跑成，绝不当 pass）
 *
 * 契约字段：{ cmd: string, args?: string[], expectExit?: number=0 }
 */

export const commandPlugin: Plugin = {
  type: "command",

  async run(contract: Contract, ctx: RunContext): Promise<CheckResult> {
    const cmd = String(contract.cmd ?? "");
    const args = Array.isArray(contract.args) ? contract.args.map(String) : [];
    const expectExit = typeof contract.expectExit === "number" ? contract.expectExit : 0;

    if (!cmd) {
      return {
        id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "契约缺少 cmd 字段，无法执行 ⇒ error",
      };
    }

    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: cmd,
      args,
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    const durationMs = evidence.durationMs;

    if (evidence.executionId !== id) {
      return {
        id: contract.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: "执行证据 ID 不匹配，结果不可信 ⇒ error",
      };
    }
    // 没跑成 → error
    if (evidence.error) {
      return {
        id: contract.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: `命令无法启动: ${evidence.error}（这不是 fail，是没跑成 ⇒ error）`,
      };
    }
    // 跑了，按退出码判 pass / fail
    if (evidence.exitCode === expectExit) {
      return { id: contract.id, type: this.type, status: "pass", durationMs, violations: [] };
    }
    return {
      id: contract.id, type: this.type, status: "fail", durationMs,
      violations: [
        {
          what: `命令退出码 ${evidence.exitCode}，期望 ${expectExit}`,
          why: contract.scenario ? String(contract.scenario) : "命令未达预期退出码",
          how: evidence.stderr.trim()
            ? `查看 stderr: ${evidence.stderr.trim().split("\n").slice(0, 3).join(" / ")}`
            : "检查命令实现",
          ref: typeof contract.ref === "string" ? contract.ref : undefined,
        },
      ],
    };
  },

  // 元测试：用契约自带 examples 标定“退出码→状态”的映射逻辑是否正确。
  // examples: { positive:[{exitCode}], negative:[{exitCode}] }
  async selfCalibrate(contract: Contract): Promise<CalibrationResult> {
    const expectExit = typeof contract.expectExit === "number" ? contract.expectExit : 0;
    const ex = (contract.examples ?? {}) as {
      positive?: Array<{ exitCode: number }>;
      negative?: Array<{ exitCode: number }>;
    };
    const classify = (exitCode: number) => (exitCode === expectExit ? "pass" : "fail");
    const details: string[] = [];
    let ok = true;
    for (const p of ex.positive ?? []) {
      const got = classify(p.exitCode);
      if (got !== "pass") { ok = false; details.push(`正例 exit=${p.exitCode} 应判 pass，实际 ${got}`); }
    }
    for (const n of ex.negative ?? []) {
      const got = classify(n.exitCode);
      if (got !== "fail") { ok = false; details.push(`反例 exit=${n.exitCode} 应判 fail，实际 ${got}`); }
    }
    if (ok) details.push("退出码→状态 映射通过正反例标定");
    return { ok, details };
  },
};

import { executionId, localExecutionTarget } from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext, Violation } from "../types.js";

interface EslintMessage { filePath?: string; messages?: Array<{ line?: number; message?: string; ruleId?: string }>; }

/**
 * structure 适配器:把语义分析委托给原生静态分析器(import-linter / eslint / dependency-cruiser / SwiftLint…)。
 * 引擎只编排,不重写分析。
 *   工具没装/起不来 → error(没跑成)
 *   工具报问题(非零退出)→ fail
 *   工具通过(退出 0)→ pass
 *
 * 契约:{ type:"structure", tool:string, args?:string[], expectExit?:0, parse?:"exit"|"eslint-json" }
 * 例:{ tool:"import-linter" } / { tool:"swiftlint", args:["lint","--strict"] }
 *    / { tool:"npx", args:["eslint","--format","json","src"], parse:"eslint-json" }
 */
export const structurePlugin: Plugin = {
  type: "structure",

  async run(c: Contract, ctx: RunContext): Promise<CheckResult> {
    const tool = String(c.tool ?? "");
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    const expectExit = typeof c.expectExit === "number" ? c.expectExit : 0;
    const parse = c.parse === "eslint-json" ? "eslint-json" : "exit";

    if (!tool) {
      return { id: c.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "契约缺少 tool 字段(要委托哪个分析器?)⇒ error" };
    }

    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: tool,
      args,
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    const durationMs = evidence.durationMs;

    if (evidence.executionId !== id) {
      return { id: c.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: "执行证据 ID 不匹配，结果不可信 ⇒ error" };
    }
    // 工具没装/起不来 ⇒ error(绝不当通过)——跨语言编排最易静默失效的点
    if (evidence.error) {
      return { id: c.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: `静态分析器无法启动: "${tool}" ${evidence.error}(可能未安装)⇒ error,绝不当通过` };
    }

    if (evidence.exitCode === expectExit) {
      return { id: c.id, type: this.type, status: "pass", durationMs, violations: [] };
    }

    // 非零退出 ⇒ fail。尽量把工具输出解析成结构化违规。
    let violations: Violation[];
    if (parse === "eslint-json") {
      violations = parseEslintJson(evidence.stdout);
    } else {
      const out = (evidence.stdout + "\n" + evidence.stderr).trim();
      violations = [
        {
          what: `${tool} 退出码 ${evidence.exitCode}(期望 ${expectExit})`,
          why: c.scenario ? String(c.scenario) : "静态分析器报告了违规",
          how: out ? out.split("\n").slice(0, 8).join("\n") : `运行 ${tool} ${args.join(" ")} 查看详情`,
          ref: typeof c.ref === "string" ? c.ref : undefined,
        },
      ];
    }
    return { id: c.id, type: this.type, status: "fail", durationMs, violations };
  },
};

function parseEslintJson(stdout: string): Violation[] {
  let report: EslintMessage[];
  try {
    report = JSON.parse(stdout) as EslintMessage[];
  } catch {
    return [{ what: "eslint 输出非 JSON", why: "无法解析 eslint --format json", how: "检查 eslint 调用与 --format json" }];
  }
  const out: Violation[] = [];
  for (const file of report) {
    for (const m of file.messages ?? []) {
      out.push({
        what: m.message ?? "lint 违规",
        why: m.ruleId ? `规则 ${m.ruleId}` : "eslint 规则",
        how: "按规则修复",
        file: file.filePath,
        line: m.line,
      });
    }
  }
  return out.length ? out : [{ what: "eslint 报告非零退出但无明细", why: "见原始输出", how: "手动运行 eslint 查看" }];
}

import { GateCore } from "../src/gate.js";
import { commandPlugin } from "../src/plugins/command.js";
import { bootPlugin } from "../src/plugins/boot.js";
import { reviewPlugin } from "../src/plugins/review.js";
import { renderPretty } from "../src/reporter.js";
import type { Contract, RunContext, Verdict } from "../src/types.js";

// 装配内核 + 注册插件（扩展点）
const gate = new GateCore().use(commandPlugin).use(bootPlugin).use(reviewPlugin);
const ctx: RunContext = { cwd: process.cwd() };

// 一条需要人工决策的契约:冻结契约失败的回归/有意变更分流
const reviewContract: Contract = {
  id: "review.frozen-contract-failed",
  type: "review",
  scenario: "订单状态契约失败:推进 done 后再 advance 不再是 no-op",
  question: "“订单不可逆”这条冻结契约失败了——是回归,还是产品要允许重开订单?",
  focalPoints: [
    "需求是否真的改成允许 done→reopen?有没有对应的需求/规格变更?",
    "若有意改变:必须先更新冻结契约(走 CODEOWNERS 审批),再放行",
    "若是回归:done 之后被改写会污染下游对账,爆炸半径大,应立即挡回",
  ],
  evidence: [
    { label: "失败契约", value: "order.done-is-terminal" },
    { label: "实际行为", value: "advance(doneOrder) 把状态改成了 reopened" },
    { label: "owner", value: "spec-team(冻结于 2026-06-01)" },
  ],
  options: [
    { id: "intended", label: "确属需求变更,更新契约后放行", resolvesTo: "pass" },
    { id: "regression", label: "判定为回归,挡回去修", resolvesTo: "fail" },
  ],
  recommended: "regression",
};

// ========== 场景一:纯人工决策 → blocked(exit 2)→ 裁决解析 ==========
console.log("\n========== 场景一 · 纯人工决策(展示 blocked 与决策重点)==========");
const blocked = await gate.run([reviewContract], ctx);
console.log(renderPretty(blocked));
console.log(`→ outcome=${blocked.outcome}, exit=${blocked.exitCode}(2=待人工决策,既不放行也不算失败)`);

console.log("\n---------- 人记录裁决: regression,重跑即解析 ----------");
const verdicts: Record<string, Verdict> = {
  "review.frozen-contract-failed": {
    optionId: "regression",
    by: "alice",
    at: new Date().toISOString(),
    reason: "无对应需求变更,done→reopen 会破坏对账,判回归",
  },
};
const resolved = await gate.run([reviewContract], { ...ctx, verdicts });
console.log(renderPretty(resolved));
console.log(`→ 裁决后 review 项解析为 ${resolved.results[0]!.status},outcome=${resolved.outcome}`);

// ========== 场景二:混合 → 四种状态共存,安全优先 ==========
console.log("\n========== 场景二 · 混合(四种状态共存,error≠pass)==========");
const mixed: Contract[] = [
  { id: "cmd.true-passes", type: "command", scenario: "true 应退出 0", cmd: "true" },
  { id: "cmd.false-fails", type: "command", scenario: "false 应退出 0(故意制造 fail)", cmd: "false" },
  { id: "cmd.missing-binary-errors", type: "command", scenario: "不存在的程序应判 error 而非 fail", cmd: "no-such-bin-xyz" },
  { id: "boot.fast-passes", type: "boot", scenario: "启动应 ≤800ms", cmd: "true", expect: { startup_ms_lte: 800 } },
  { id: "unknown.type-errors", type: "smell-test", scenario: "未注册 type 必须判 error" },
  reviewContract,
];
const mixedReport = await gate.run(mixed, ctx);
console.log(renderPretty(mixedReport));
console.log(`→ outcome=${mixedReport.outcome}, exit=${mixedReport.exitCode}`);
console.log(`已注册插件: [${gate.plugins().join(", ")}]`);

console.log(
  "\n要点:\n" +
    "  · blocked(exit 2)只在‘只有待决策、无 fail/error’时出现——场景一。\n" +
    "  · 一旦有 fail/error,outcome=fail(exit 1)优先于待决策(安全优先)——场景二。\n" +
    "  · 全程 error≠pass:不存在的程序、未注册 type 都判 error,绝不放行。\n",
);

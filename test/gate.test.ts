import { test } from "node:test";
import assert from "node:assert/strict";

import { GateCore } from "../src/gate.js";
import { PluginRegistry } from "../src/registry.js";
import { aggregate, resolveWithVerdict } from "../src/aggregate.js";
import { commandPlugin } from "../src/plugins/command.js";
import { bootPlugin } from "../src/plugins/boot.js";
import { reviewPlugin } from "../src/plugins/review.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../src/types.js";

const ctx: RunContext = { cwd: process.cwd() };
const mk = (status: CheckResult["status"], id = status): CheckResult =>
  ({ id, type: "t", status, durationMs: 0, violations: [] });

// ---------- registry ----------
test("registry: 重复注册同一 type 直接报错", () => {
  const r = new PluginRegistry().register(commandPlugin);
  assert.throws(() => r.register(commandPlugin), /已注册/);
});

// ---------- 红线: 未知 type → error, 绝不静默 pass ----------
test("未注册 type 判 error(不是 pass),且整体 fail", async () => {
  const gate = new GateCore();
  const report = await gate.run([{ id: "x", type: "nope" }], ctx);
  assert.equal(report.results[0]!.status, "error");
  assert.equal(report.outcome, "fail");
  assert.equal(report.exitCode, 1);
});

// ---------- 红线: 插件抛异常 → error ----------
test("插件执行抛异常判 error", async () => {
  const boom: Plugin = { type: "boom", async run() { throw new Error("kaboom"); } };
  const gate = new GateCore().use(boom);
  const report = await gate.run([{ id: "b", type: "boom" }], ctx);
  assert.equal(report.results[0]!.status, "error");
  assert.match(report.results[0]!.errorReason ?? "", /kaboom/);
});

// ---------- command: exit0=pass, exit≠0=fail, 缺失程序=error ----------
test("command: true → pass", async () => {
  const r = await commandPlugin.run({ id: "t", type: "command", cmd: "true" }, ctx);
  assert.equal(r.status, "pass");
});
test("command: false → fail (跑了但未达预期)", async () => {
  const r = await commandPlugin.run({ id: "f", type: "command", cmd: "false" }, ctx);
  assert.equal(r.status, "fail");
  assert.ok(r.violations.length > 0);
});
test("command: 不存在的程序 → error (不是 fail)", async () => {
  const r = await commandPlugin.run({ id: "e", type: "command", cmd: "no-such-bin-xyz-123" }, ctx);
  assert.equal(r.status, "error");
  assert.match(r.errorReason ?? "", /无法启动/);
});

// ---------- boot: 达标=pass, 超时=fail, 起不来=error ----------
test("boot: 快速命令在宽松 SLA 下 pass", async () => {
  const r = await bootPlugin.run({ id: "ok", type: "boot", cmd: "true", expect: { startup_ms_lte: 100000 } }, ctx);
  assert.equal(r.status, "pass");
});
test("boot: 超过 SLA → fail", async () => {
  const r = await bootPlugin.run(
    { id: "slow", type: "boot", cmd: "sleep", args: ["0.15"], expect: { startup_ms_lte: 10 } },
    ctx,
  );
  assert.equal(r.status, "fail");
});

// ---------- aggregate(纯函数)优先级 ----------
test("aggregate: 任何 error → fail/exit1", () => {
  const rep = aggregate([mk("pass"), mk("error")]);
  assert.equal(rep.outcome, "fail");
  assert.equal(rep.exitCode, 1);
});
test("aggregate: 有 fail 无 error → fail/exit1", () => {
  assert.equal(aggregate([mk("pass"), mk("fail")]).exitCode, 1);
});
test("aggregate: 只有 needs_review → blocked/exit2", () => {
  const rep = aggregate([mk("pass"), mk("needs_review")]);
  assert.equal(rep.outcome, "blocked");
  assert.equal(rep.exitCode, 2);
  assert.equal(rep.pendingDecisions.length, 1);
});
test("aggregate: 全 pass → pass/exit0", () => {
  assert.equal(aggregate([mk("pass"), mk("pass")]).exitCode, 0);
});
test("aggregate: error 优先于 needs_review(安全优先)", () => {
  assert.equal(aggregate([mk("needs_review"), mk("error")]).outcome, "fail");
});

// ---------- resolveWithVerdict ----------
const reviewResult = (): CheckResult => ({
  id: "rv", type: "review", status: "needs_review", durationMs: 0, violations: [],
  decision: {
    question: "?", focalPoints: [], evidence: [],
    options: [
      { id: "ok", label: "放行", resolvesTo: "pass" },
      { id: "no", label: "挡回", resolvesTo: "fail" },
    ],
  },
});
test("verdict: 选 pass 选项 → pass", () => {
  const r = resolveWithVerdict(reviewResult(), { optionId: "ok", by: "a", at: "now" });
  assert.equal(r.status, "pass");
});
test("verdict: 选 fail 选项 → fail 且带违规", () => {
  const r = resolveWithVerdict(reviewResult(), { optionId: "no", by: "a", at: "now", reason: "回归" });
  assert.equal(r.status, "fail");
  assert.match(r.violations[0]!.why, /回归/);
});
test("verdict: 无效选项 → error(不静默放行)", () => {
  const r = resolveWithVerdict(reviewResult(), { optionId: "ghost", by: "a", at: "now" });
  assert.equal(r.status, "error");
});

// ---------- review 插件 + GateCore 端到端解析 ----------
test("review: 无裁决时 blocked;有裁决时解析", async () => {
  const gate = new GateCore().use(reviewPlugin);
  const c: Contract = { id: "r1", type: "review", scenario: "测试" };
  const blocked = await gate.run([c], ctx);
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.results[0]!.status, "needs_review");
  assert.ok(blocked.results[0]!.decision); // 携带决策重点

  const resolved = await gate.run([c], {
    ...ctx,
    verdicts: { r1: { optionId: "regression", by: "a", at: "now", reason: "x" } },
  });
  assert.equal(resolved.results[0]!.status, "fail");
});

// ---------- 元测试: 用 examples 标定 command 的退出码映射 ----------
test("calibrate: 正确 examples 通过标定", async () => {
  const gate = new GateCore().use(commandPlugin);
  const c: Contract = {
    id: "cal", type: "command", cmd: "true", expectExit: 0,
    examples: { positive: [{ exitCode: 0 }], negative: [{ exitCode: 1 }, { exitCode: 127 }] },
  };
  const { ok } = await gate.calibrate([c]);
  assert.equal(ok, true);
});
test("calibrate: 映射与 examples 矛盾时标定失败", async () => {
  // expectExit=1 → classify(0)=fail,但 example 说 0 是正例(应 pass)→ 标定必须失败
  const r = await commandPlugin.selfCalibrate!({
    id: "bad", type: "command", cmd: "true", expectExit: 1,
    examples: { positive: [{ exitCode: 0 }] },
  });
  assert.equal(r.ok, false);
});

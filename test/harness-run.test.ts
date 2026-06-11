import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GateCore } from "../src/gate.js";
import { reviewPlugin } from "../src/plugins/review.js";
import { runLoop, type GenerationBudget } from "../src/harness/run.js";
import type { AgentDriver } from "../src/harness/drivers.js";
import { loadVerdicts, recordVerdict } from "../src/harness/verdicts.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../src/types.js";

const ctx: RunContext = { cwd: process.cwd() };
const budget = (over: Partial<GenerationBudget> = {}): GenerationBudget => ({
  maxAttempts: 5, maxTokens: 1e9, maxMs: 600_000, contextThreshold: 0.99, repeatWallThreshold: 99, ...over,
});

// 假插件:状态由共享 flag 决定;假 driver:第 N 次调用时“修好”
function flakyPlugin(state: { fixed: boolean }): Plugin {
  return {
    type: "flaky",
    async run(c: Contract): Promise<CheckResult> {
      return state.fixed
        ? { id: c.id, type: "flaky", status: "pass", durationMs: 0, violations: [] }
        : { id: c.id, type: "flaky", status: "fail", durationMs: 0, violations: [{ what: "未实现", why: "y", how: "z" }] };
    },
  };
}

test("runLoop: 失败→driver 修复→就绪(2 轮)", async () => {
  const state = { fixed: false };
  let calls = 0;
  const driver: AgentDriver = { name: "fix", async runTask() { calls++; if (calls >= 2) state.fixed = true; return { summary: "改了", changedFiles: [] }; } };
  const gate = new GateCore().use(flakyPlugin(state));
  const out = await runLoop({ task: "t", cwd: ".", contracts: [{ id: "c1", type: "flaky" }], gate, ctx, driver, budget: budget() });
  assert.equal(out.outcome, "ready_for_mr");
  assert.equal(out.attempts, 2);
});

test("runLoop: driver 永不修复 → 预算耗尽升级 stop_for_human", async () => {
  const state = { fixed: false };
  const driver: AgentDriver = { name: "noop", async runTask() { return { summary: "空跑", changedFiles: [] }; } };
  const gate = new GateCore().use(flakyPlugin(state));
  const out = await runLoop({ task: "t", cwd: ".", contracts: [{ id: "c1", type: "flaky" }], gate, ctx, driver, budget: budget({ maxAttempts: 2 }) });
  assert.equal(out.outcome, "escalated");
  assert.equal(out.action?.kind, "stop_for_human");
});

test("runLoop: 反复撞同一墙 → 升级 human_review_contract", async () => {
  const state = { fixed: false };
  const driver: AgentDriver = { name: "noop", async runTask() { return { summary: "空跑", changedFiles: [] }; } };
  const gate = new GateCore().use(flakyPlugin(state));
  const out = await runLoop({ task: "t", cwd: ".", contracts: [{ id: "c1", type: "flaky" }], gate, ctx, driver, budget: budget({ maxAttempts: 10, repeatWallThreshold: 3 }) });
  assert.equal(out.outcome, "escalated");
  assert.equal(out.action?.kind, "human_review_contract");
});

test("runLoop: 只有 needs_review → blocked,立即返回不迭代", async () => {
  const driver: AgentDriver = { name: "noop", async runTask() { return { summary: "x", changedFiles: [] }; } };
  const gate = new GateCore().use(reviewPlugin);
  const out = await runLoop({ task: "t", cwd: ".", contracts: [{ id: "r1", type: "review", scenario: "s" }], gate, ctx, driver, budget: budget() });
  assert.equal(out.outcome, "blocked");
  assert.equal(out.attempts, 1);
});

test("runLoop: 完成后关闭 driver", async () => {
  const state = { fixed: true };
  let closes = 0;
  const driver: AgentDriver = {
    name: "closable",
    async runTask() { return { summary: "完成", changedFiles: [] }; },
    async close() { closes++; },
  };
  const gate = new GateCore().use(flakyPlugin(state));

  const out = await runLoop({
    task: "t",
    cwd: ".",
    contracts: [{ id: "c1", type: "flaky" }],
    gate,
    ctx,
    driver,
    budget: budget(),
  });

  assert.equal(out.outcome, "ready_for_mr");
  assert.equal(closes, 1);
});

test("runLoop: driver 抛错时仍关闭 driver", async () => {
  let closes = 0;
  const driver: AgentDriver = {
    name: "broken",
    async runTask() { throw new Error("driver failed"); },
    async close() { closes++; },
  };
  const gate = new GateCore().use(flakyPlugin({ fixed: true }));

  await assert.rejects(
    () => runLoop({
      task: "t",
      cwd: ".",
      contracts: [{ id: "c1", type: "flaky" }],
      gate,
      ctx,
      driver,
      budget: budget(),
    }),
    /driver failed/,
  );
  assert.equal(closes, 1);
});

// ---------- 裁决存储 ----------
test("verdicts: 记录后可读回", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hv-"));
  assert.deepEqual(loadVerdicts(cwd), {});
  recordVerdict(cwd, "order.done", { optionId: "regression", by: "alice", at: "now", reason: "回归" });
  const v = loadVerdicts(cwd);
  assert.equal(v["order.done"]!.optionId, "regression");
  assert.equal(v["order.done"]!.by, "alice");
});

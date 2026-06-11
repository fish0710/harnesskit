import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEscalation, type LoopState } from "../src/agent/escalation.js";

const base = (over: Partial<LoopState> = {}): LoopState => ({
  attempts: 1, maxAttempts: 10,
  tokensUsed: 0, maxTokens: 1_000_000,
  elapsedMs: 0, maxMs: 600_000,
  contextUsedRatio: 0, contextThreshold: 0.85,
  failStreakByCheck: {}, repeatWallThreshold: 3,
  ...over,
});

test("escalation: 一切正常 → continue", () => {
  assert.equal(decideEscalation(base()).kind, "continue");
});

test("escalation: context 将满 → swap_instance(优先)", () => {
  const a = decideEscalation(base({ contextUsedRatio: 0.9 }));
  assert.equal(a.kind, "swap_instance");
});

test("escalation: 反复撞同一墙 → human_review_contract(指出疑似契约错)", () => {
  const a = decideEscalation(base({ failStreakByCheck: { "pay.contract": 3 } }));
  assert.equal(a.kind, "human_review_contract");
  if (a.kind === "human_review_contract") assert.equal(a.checkId, "pay.contract");
});

test("escalation: 预算耗尽(轮数)→ stop_for_human", () => {
  const a = decideEscalation(base({ attempts: 10 }));
  assert.equal(a.kind, "stop_for_human");
});

test("escalation: 预算耗尽(tokens)→ stop_for_human", () => {
  assert.equal(decideEscalation(base({ tokensUsed: 1_000_000 })).kind, "stop_for_human");
});

test("escalation: 预算耗尽(时长)→ stop_for_human", () => {
  assert.equal(decideEscalation(base({ elapsedMs: 600_000 })).kind, "stop_for_human");
});

test("escalation: context 优先于撞墙与预算", () => {
  const a = decideEscalation(base({ contextUsedRatio: 0.9, failStreakByCheck: { x: 5 }, attempts: 99 }));
  assert.equal(a.kind, "swap_instance");
});

test("escalation: 撞墙优先于预算", () => {
  const a = decideEscalation(base({ failStreakByCheck: { x: 3 }, attempts: 99 }));
  assert.equal(a.kind, "human_review_contract");
});

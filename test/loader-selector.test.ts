import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadContracts, validateContract, contractHash, freezeContract, verifyFrozen } from "../src/contracts.js";
import { selectByChange, selectByStage, type SelectConfig } from "../src/selector.js";
import type { Contract } from "../src/types.js";

// ---------- loader ----------
test("loader: 加载 yaml + json,校验通过的进集合", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  writeFileSync(join(dir, "a.yaml"), "id: a.http\ntype: http\ntrigger:\n  url: http://x/y\nexpect:\n  status: 200\n");
  writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "b.cmd", type: "command", cmd: "true" }));
  const { contracts, issues } = loadContracts(dir);
  assert.equal(issues.length, 0);
  assert.equal(contracts.length, 2);
  assert.ok(contracts.find((c) => c.id === "a.http"));
});

test("loader: 缺 id → 记 issue,且不进集合", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  writeFileSync(join(dir, "bad.yaml"), "type: command\ncmd: true\n");
  const { contracts, issues } = loadContracts(dir);
  assert.equal(contracts.length, 0);
  assert.ok(issues.some((i) => /缺少 id/.test(i.message)));
});

test("loader: 已知 type 缺必填字段 → issue(http 缺 trigger)", () => {
  const v = validateContract({ id: "x", type: "http" });
  assert.ok(v.some((i) => /缺少必填字段 "trigger"/.test(i.message)));
});

test("loader: 数组文件 + 子目录递归", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "arr.yaml"), "- {id: x1, type: command, cmd: true}\n- {id: x2, type: command, cmd: true}\n");
  writeFileSync(join(dir, "sub", "c.json"), JSON.stringify({ id: "x3", type: "command", cmd: "true" }));
  const { contracts } = loadContracts(dir);
  assert.equal(contracts.length, 3);
});

// ---------- freeze / verify ----------
test("freeze + verify: 冻结后校验通过;篡改内容后校验失败", () => {
  const c: Contract = { id: "f", type: "command", cmd: "true", expectExit: 0 };
  const frozen = freezeContract(c);
  assert.equal(frozen.frozen, true);
  assert.equal(typeof frozen.hash, "string");
  assert.equal(verifyFrozen(frozen).ok, true);

  const tampered: Contract = { ...frozen, expectExit: 1 }; // 改了内容但保留旧 hash
  const res = verifyFrozen(tampered);
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /被改|不符/);
});

test("hash: 不受 frozen/frozen_at/hash 字段影响(只看内容)", () => {
  const c: Contract = { id: "h", type: "command", cmd: "true" };
  const h1 = contractHash(c);
  const h2 = contractHash({ ...c, frozen: true, frozen_at: "2020", hash: "deadbeef" });
  assert.equal(h1, h2);
});

// ---------- selector ----------
const all: Contract[] = [
  { id: "base.smoke", type: "command", cmd: "true" },
  { id: "pay.contract", type: "http", trigger: {} },
  { id: "auth.contract", type: "http", trigger: {} },
  { id: "ui.flow", type: "review", stage: "generation" },
];
const config: SelectConfig = {
  baseline: ["base.smoke"],
  rules: [
    { when: ["src/payment/**"], select: ["pay.contract"] },
    { when: ["src/auth/**"], select: ["auth.contract"] },
  ],
};

test("selector: 基线恒选(无改动也在)", () => {
  const { selected } = selectByChange(all, config, []);
  assert.deepEqual(selected.map((c) => c.id), ["base.smoke"]);
});

test("selector: 改动命中规则 → 追加(基线仍在)", () => {
  const { selected, reasons } = selectByChange(all, config, ["src/payment/charge.ts"]);
  const ids = selected.map((c) => c.id).sort();
  assert.deepEqual(ids, ["base.smoke", "pay.contract"]);
  assert.match(reasons["pay.contract"]!, /追加/);
});

test("selector: 只增不减 —— 未命中的契约不会被选,但基线绝不被去掉", () => {
  const { selected } = selectByChange(all, config, ["src/payment/x.ts"]);
  // auth.contract 未命中 → 不选;base.smoke 基线 → 必在
  assert.ok(selected.find((c) => c.id === "base.smoke"));
  assert.ok(!selected.find((c) => c.id === "auth.contract"));
});

test("selector: glob ** 跨层匹配", () => {
  const { selected } = selectByChange(all, config, ["src/payment/sub/deep/file.ts"]);
  assert.ok(selected.find((c) => c.id === "pay.contract"));
});

test("selector: selectByStage 按 stage 过滤", () => {
  assert.deepEqual(selectByStage(all, "generation").map((c) => c.id), ["ui.flow"]);
});

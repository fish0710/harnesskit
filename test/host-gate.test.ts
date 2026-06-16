import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializeCandidateWorkspace,
  runHostLocalGate,
} from "../src/harness/host-gate.js";
import { GateCore } from "../src/gate.js";
import type { Plugin } from "../src/types.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import { workspaceFile } from "../src/harness/sandbox/workspace.js";
import type {
  CandidateSnapshot,
  WorkspaceSnapshot,
} from "../src/harness/sandbox/types.js";

function snapshot(root: string, files: Record<string, string>): WorkspaceSnapshot {
  return {
    root,
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        workspaceFile(path, Buffer.from(content), false),
      ]),
    ),
  };
}

function candidate(files: Record<string, string>): CandidateSnapshot {
  return {
    operations: [],
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        workspaceFile(path, Buffer.from(content), false),
      ]),
    ),
  };
}

function tempGateRoots(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("harness-host-gate-"))
      .map((name) => join(tmpdir(), name)),
  );
}

function addedTempGateRoots(before: Set<string>): string[] {
  return [...tempGateRoots()].filter((path) => !before.has(path));
}

test("materializeCandidateWorkspace writes candidate bytes and restores protected files", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(root, {
    "src/a.ts": "before\n",
    "src/deleted.ts": "delete me\n",
    "contracts/mp.yaml": "trusted contract\n",
  });
  const next = candidate({ "src/a.ts": "after\n" });

  materializeCandidateWorkspace(root, baseline, next, policy);

  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "after\n");
  assert.equal(existsSync(join(root, "src/deleted.ts")), false);
  assert.equal(
    readFileSync(join(root, "contracts/mp.yaml"), "utf8"),
    "trusted contract\n",
  );
});

test("materializeCandidateWorkspace rejects symlink parents without writing outside root", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  const outside = mkdtempSync(join(tmpdir(), "harness-host-gate-outside-"));
  symlinkSync(outside, join(root, "src"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(root, {
    "contracts/mp.yaml": "trusted contract\n",
  });
  const next = candidate({ "src/pwn.txt": "outside write\n" });

  assert.throws(
    () => materializeCandidateWorkspace(root, baseline, next, policy),
    /符号链接|symlink|父路径|parent/i,
  );
  assert.equal(existsSync(join(outside, "pwn.txt")), false);
});

test("materializeCandidateWorkspace rejects protected candidates without overwriting baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(join(root, "contracts/mp.yaml"), "trusted contract\n");
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(root, {
    "contracts/mp.yaml": "trusted contract\n",
  });
  const next = candidate({ "contracts/mp.yaml": "candidate contract\n" });

  assert.throws(
    () => materializeCandidateWorkspace(root, baseline, next, policy),
    /受保护|protected|允许范围|candidate/i,
  );
  assert.equal(
    readFileSync(join(root, "contracts/mp.yaml"), "utf8"),
    "trusted contract\n",
  );
});

test("materializeCandidateWorkspace rejects traversal and absolute candidate paths", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(root, {});

  for (const path of ["../escape.txt", "/tmp/escape.txt"]) {
    const next: CandidateSnapshot = {
      operations: [],
      files: new Map([
        [path, workspaceFile(path, Buffer.from("escape\n"), false)],
      ]),
    };

    assert.throws(
      () => materializeCandidateWorkspace(root, baseline, next, policy),
      /绝对路径|非法路径|越界|absolute|path/i,
    );
  }
});

test("runHostLocalGate cleans the temporary root when materialization throws", async () => {
  const realRoot = mkdtempSync(join(tmpdir(), "harness-real-root-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const before = tempGateRoots();
  const next = candidate({ "contracts/mp.yaml": "candidate contract\n" });

  await assert.rejects(
    () =>
      runHostLocalGate({
        contracts: [],
        gate: new GateCore(),
        ctx: { cwd: realRoot },
        baseline: snapshot(realRoot, {
          "contracts/mp.yaml": "trusted contract\n",
        }),
        candidate: next,
        policy,
      }),
    /受保护|protected|允许范围|candidate/i,
  );
  assert.deepEqual(addedTempGateRoots(before), []);
});

test("runHostLocalGate cleans the temporary root when a plugin throws", async () => {
  const realRoot = mkdtempSync(join(tmpdir(), "harness-real-root-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  let observedCwd = "";
  const plugin: Plugin = {
    type: "miniprogram",
    async run(_contract, ctx) {
      observedCwd = ctx.cwd;
      throw new Error("plugin failed");
    },
  };

  const report = await runHostLocalGate({
    contracts: [{ id: "mp.host", type: "miniprogram" }],
    gate: new GateCore().use(plugin),
    ctx: { cwd: realRoot },
    baseline: snapshot(realRoot, {
      "src/a.ts": "before\n",
      "contracts/mp.yaml": "trusted\n",
    }),
    candidate: candidate({ "src/a.ts": "after\n" }),
    policy,
  });

  assert.equal(report.outcome, "fail");
  assert.match(report.results[0]?.errorReason ?? "", /plugin failed/);
  assert.notEqual(observedCwd, "");
  assert.equal(existsSync(observedCwd), false);
});

test("runHostLocalGate executes contracts in a temporary candidate workspace", async () => {
  const realRoot = mkdtempSync(join(tmpdir(), "harness-real-root-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(realRoot, {
    "src/a.ts": "before\n",
    "contracts/mp.yaml": "trusted\n",
  });
  const next = candidate({ "src/a.ts": "after\n" });
  let observedCwd = "";
  const plugin: Plugin = {
    type: "miniprogram",
    async run(contract, ctx) {
      observedCwd = ctx.cwd;
      return {
        id: contract.id,
        type: this.type,
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "after\n"
          ? "pass"
          : "fail",
        durationMs: 1,
        violations: [],
      };
    },
  };

  const report = await runHostLocalGate({
    contracts: [
      {
        id: "mp.host",
        type: "miniprogram",
        projectPath: "src",
        runner: "contracts/mp.yaml",
      },
    ],
    gate: new GateCore().use(plugin),
    ctx: { cwd: realRoot },
    baseline,
    candidate: next,
    policy,
  });

  assert.equal(report.outcome, "pass");
  assert.notEqual(observedCwd, realRoot);
  assert.equal(existsSync(observedCwd), false);
});

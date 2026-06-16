import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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

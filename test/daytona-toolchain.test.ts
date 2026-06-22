import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertClaudeToolchain,
  CLAUDE_CODE_VERSION,
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_LATEST_SNAPSHOT,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_RELEASE,
  DAYTONA_AGENT_SNAPSHOT,
  DAYTONA_GATE_IMAGE,
  DAYTONA_GATE_LATEST_SNAPSHOT,
  DAYTONA_GATE_REGISTRY_IMAGE,
  DAYTONA_GATE_RELEASE,
  DAYTONA_GATE_SNAPSHOT,
  LEGACY_NODE_VERSION,
  LEGACY_NPM_VERSION,
  NODE_VERSION,
  getGateSnapshot,
  requireAgentSnapshot,
} from "../src/harness/sandbox/toolchain.js";

test("runtime image releases are pinned to stable latest snapshot names", () => {
  assert.equal(NODE_VERSION, "22.14.0");
  assert.equal(LEGACY_NODE_VERSION, "14.21.3");
  assert.equal(LEGACY_NPM_VERSION, "6.14.18");
  assert.equal(CLAUDE_CODE_VERSION, "2.1.145");
  assert.equal(DAYTONA_AGENT_RELEASE, "2.1.145-r2");
  assert.equal(DAYTONA_AGENT_IMAGE, "harness-daytona-claude:2.1.145-r2");
  assert.equal(
    DAYTONA_AGENT_REGISTRY_IMAGE,
    "registry:6000/harness/harness-daytona-claude:2.1.145-r2",
  );
  assert.equal(
    DAYTONA_AGENT_SNAPSHOT,
    "harness-agent-claude-2.1.145-r2",
  );
  assert.equal(DAYTONA_AGENT_LATEST_SNAPSHOT, "harness-agent-claude-latest");
  assert.equal(DAYTONA_GATE_RELEASE, "node-22.14.0-r2");
  assert.equal(DAYTONA_GATE_IMAGE, "harness-daytona-gate:node-22.14.0-r2");
  assert.equal(
    DAYTONA_GATE_REGISTRY_IMAGE,
    "registry:6000/harness/harness-daytona-gate:node-22.14.0-r2",
  );
  assert.equal(DAYTONA_GATE_SNAPSHOT, "harness-gate-runtime-node-22.14.0-r2");
  assert.equal(DAYTONA_GATE_LATEST_SNAPSHOT, "harness-gate-runtime-latest");
});

test("preflight accepts the exact image toolchain", () => {
  assert.doesNotThrow(() =>
    assertClaudeToolchain({
      exitCode: 0,
      stdout:
        "node=v22.14.0\nnpm=10.9.2\nnpx=10.9.2\n" +
        "claude=2.1.145 (Claude Code)\nbash=/usr/bin/bash\n",
      stderr: "",
    })
  );
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/node/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/npm/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/npx/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/claude/);
  assert.match(
    CLAUDE_TOOLCHAIN_PREFLIGHT,
    /node=%s\\nnpm=%s\\nnpx=%s\\nclaude=%s\\nbash=%s\\n/,
  );
});

test("preflight rejects command failure", () => {
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 127,
        stdout: "",
        stderr: "claude: not found",
      }),
    /Claude toolchain preflight failed.*claude: not found/i,
  );
});

test("preflight rejects drifted Node.js and Claude Code versions", () => {
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout:
          "node=v22.15.0\nnpm=10.9.2\nnpx=10.9.2\n" +
          "claude=2.1.145 (Claude Code)\nbash=/usr/bin/bash\n",
        stderr: "",
      }),
    /expected Node\.js 22\.14\.0.*22\.15\.0/i,
  );
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout:
          "node=v22.14.0\nnpm=10.9.2\nnpx=10.9.2\n" +
          "claude=2.1.177 (Claude Code)\nbash=/usr/bin/bash\n",
        stderr: "",
      }),
    /expected Claude Code 2\.1\.145.*2\.1\.177/i,
  );
});

test("preflight rejects missing npm or npx output", () => {
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout:
          "node=v22.14.0\nnpx=10.9.2\n" +
          "claude=2.1.145 (Claude Code)\n",
        stderr: "",
      }),
    /npm=missing.*npx=10\.9\.2/i,
  );
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout:
          "node=v22.14.0\nnpm=10.9.2\n" +
          "claude=2.1.145 (Claude Code)\n",
        stderr: "",
      }),
    /npm=10\.9\.2.*npx=missing/i,
  );
});

test("Claude runs default to the stable Agent latest Snapshot", () => {
  assert.equal(
    requireAgentSnapshot({
      HARNESS_DAYTONA_AGENT_SNAPSHOT: ` ${DAYTONA_AGENT_SNAPSHOT} `,
    }),
    DAYTONA_AGENT_SNAPSHOT,
  );
  assert.equal(requireAgentSnapshot({}), DAYTONA_AGENT_LATEST_SNAPSHOT);
  assert.throws(
    () => requireAgentSnapshot({ HARNESS_DAYTONA_AGENT_SNAPSHOT: "   " }),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
});

test("Gate runs default to the stable Gate latest Snapshot", () => {
  assert.equal(getGateSnapshot({}), DAYTONA_GATE_LATEST_SNAPSHOT);
  assert.equal(
    getGateSnapshot({
      HARNESS_DAYTONA_GATE_SNAPSHOT: ` ${DAYTONA_GATE_SNAPSHOT} `,
    }),
    DAYTONA_GATE_SNAPSHOT,
  );
  assert.throws(
    () => getGateSnapshot({ HARNESS_DAYTONA_GATE_SNAPSHOT: "   " }),
    /HARNESS_DAYTONA_GATE_SNAPSHOT/,
  );
});

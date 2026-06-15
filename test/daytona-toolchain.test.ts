import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAUDE_CODE_VERSION,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_RELEASE,
  DAYTONA_AGENT_SNAPSHOT,
  NODE_VERSION,
  requireAgentSnapshot,
} from "../src/harness/sandbox/toolchain.js";

test("agent image release is pinned to the approved local toolchain", () => {
  assert.equal(NODE_VERSION, "22.14.0");
  assert.equal(CLAUDE_CODE_VERSION, "2.1.145");
  assert.equal(DAYTONA_AGENT_RELEASE, "2.1.145-r1");
  assert.equal(DAYTONA_AGENT_IMAGE, "harness-daytona-claude:2.1.145-r1");
  assert.equal(
    DAYTONA_AGENT_REGISTRY_IMAGE,
    "registry:6000/harness/harness-daytona-claude:2.1.145-r1",
  );
  assert.equal(
    DAYTONA_AGENT_SNAPSHOT,
    "harness-agent-claude-2.1.145-r1",
  );
});

test("Claude runs require an explicit host-selected Agent Snapshot", () => {
  assert.equal(
    requireAgentSnapshot({
      HARNESS_DAYTONA_AGENT_SNAPSHOT: ` ${DAYTONA_AGENT_SNAPSHOT} `,
    }),
    DAYTONA_AGENT_SNAPSHOT,
  );
  assert.throws(
    () => requireAgentSnapshot({}),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
  assert.throws(
    () => requireAgentSnapshot({ HARNESS_DAYTONA_AGENT_SNAPSHOT: "   " }),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
});

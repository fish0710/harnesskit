import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCompatibleSnapshot,
  buildImageCommands,
} from "../src/tools/daytona-agent-snapshot.js";
import {
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_SNAPSHOT,
} from "../src/harness/sandbox/toolchain.js";

test("build plan targets the Daytona runner and internal registry", () => {
  assert.deepEqual(
    buildImageCommands("daytona-runner-1", "/tmp/context"),
    [
      [
        "docker",
        [
          "exec",
          "daytona-runner-1",
          "sh",
          "-lc",
          "rm -rf /tmp/context && mkdir -p /tmp/context",
        ],
      ],
      [
        "docker",
        [
          "cp",
          "images/daytona/claude/.",
          "daytona-runner-1:/tmp/context",
        ],
      ],
      [
        "docker",
        [
          "exec",
          "daytona-runner-1",
          "docker",
          "build",
          "--pull=false",
          "-t",
          DAYTONA_AGENT_IMAGE,
          "/tmp/context",
        ],
      ],
      [
        "docker",
        [
          "exec",
          "daytona-runner-1",
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "/bin/sh",
          DAYTONA_AGENT_IMAGE,
          "-lc",
          "node --version && npm --version && npx --version && claude --version",
        ],
      ],
      [
        "docker",
        [
          "exec",
          "daytona-runner-1",
          "docker",
          "tag",
          DAYTONA_AGENT_IMAGE,
          DAYTONA_AGENT_REGISTRY_IMAGE,
        ],
      ],
      [
        "docker",
        [
          "exec",
          "daytona-runner-1",
          "docker",
          "push",
          DAYTONA_AGENT_REGISTRY_IMAGE,
        ],
      ],
    ],
  );
});

test("existing Snapshot must match the immutable registry image", () => {
  assert.doesNotThrow(() =>
    assertCompatibleSnapshot({
      name: DAYTONA_AGENT_SNAPSHOT,
      imageName: DAYTONA_AGENT_REGISTRY_IMAGE,
      state: "inactive",
    }),
  );
  assert.throws(
    () =>
      assertCompatibleSnapshot({
        name: DAYTONA_AGENT_SNAPSHOT,
        imageName: "registry:6000/harness/other:tag",
        state: "active",
      }),
    /immutable Snapshot.*r2/i,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCompatibleSnapshot,
  buildImageCommands,
  explainSnapshotCreateError,
  readAgentDockerfile,
} from "../src/tools/daytona-agent-snapshot.js";
import {
  assertClaudeToolchain,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_SNAPSHOT,
} from "../src/harness/sandbox/toolchain.js";

test("build plan targets the Daytona runner and internal registry", () => {
  assert.deepEqual(
    buildImageCommands("daytona-runner-1", "/tmp/context"),
    [
      [
        "sh",
        [
          "-lc",
          "COPYFILE_DISABLE=1 tar -C 'images/daytona/claude' -cf - . | " +
            "docker exec -i 'daytona-runner-1' sh -lc " +
            "'rm -rf '\"'\"'/tmp/context'\"'\"' && " +
            "mkdir -p '\"'\"'/tmp/context'\"'\"' && " +
            "tar -C '\"'\"'/tmp/context'\"'\"' -xf -'",
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
          "test -x /usr/bin/bash && node --version && " +
            "npm --version && npx --version && claude --version",
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

test("existing Snapshot can match the immutable Dockerfile buildInfo", () => {
  assert.doesNotThrow(() =>
    assertCompatibleSnapshot({
      name: DAYTONA_AGENT_SNAPSHOT,
      imageName: "snapshot-builder.internal/harness/generated:latest",
      buildInfo: {
        dockerfileContent: readAgentDockerfile(),
      },
      state: "inactive",
    }),
  );
});

test("snapshot create access denial explains required Daytona permissions", () => {
  const explained = explainSnapshotCreateError(new Error("Access denied"));
  assert.match(explained.message, /write:snapshots/);
  assert.match(explained.message, /Docker registry/);
});

test("preflight rejects Agent images without bash for PTY startup", () => {
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout: [
          "node=v22.14.0",
          "npm=10.9.2",
          "npx=10.9.2",
          "claude=2.1.145 (Claude Code)",
        ].join("\n"),
        stderr: "",
      }),
    /bash/i,
  );
});

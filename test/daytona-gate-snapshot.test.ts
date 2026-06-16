import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGateImageCommands,
  readGateDockerfile,
} from "../src/tools/daytona-gate-snapshot.js";
import {
  DAYTONA_GATE_IMAGE,
  DAYTONA_GATE_REGISTRY_IMAGE,
  DAYTONA_GATE_SNAPSHOT,
} from "../src/harness/sandbox/toolchain.js";

test("gate image build plan targets a minimal runtime without Claude", () => {
  const commands = buildGateImageCommands("daytona-runner-1", "/tmp/context");
  const serialized = JSON.stringify(commands);

  assert.match(serialized, /images\/daytona\/gate/);
  assert.match(serialized, new RegExp(DAYTONA_GATE_IMAGE));
  assert.match(serialized, new RegExp(DAYTONA_GATE_REGISTRY_IMAGE));
  assert.match(serialized, /test -x \/usr\/bin\/bash/);
  assert.match(serialized, /node --version/);
  assert.match(serialized, /npm --version/);
  assert.match(serialized, /npx --version/);
  assert.match(serialized, /python3 --version/);
  assert.match(serialized, /curl --version/);
  assert.equal(serialized.includes("claude"), false);
});

test("gate Dockerfile contains no Claude installation path", () => {
  const dockerfile = readGateDockerfile();

  assert.match(dockerfile, /FROM daytonaio\/sandbox:0\.5\.0-slim/);
  assert.match(dockerfile, /ARG NODE_VERSION=22\.14\.0/);
  assert.match(dockerfile, /apt-get install/);
  assert.match(dockerfile, /bash/);
  assert.match(dockerfile, /python3/);
  assert.match(dockerfile, /curl/);
  assert.equal(dockerfile.includes("claude"), false);
});

test("gate latest snapshot has a stable replacement target name", () => {
  assert.equal(DAYTONA_GATE_SNAPSHOT, "harness-gate-runtime-node-22.14.0-r1");
});

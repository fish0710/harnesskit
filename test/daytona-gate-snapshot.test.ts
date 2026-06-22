import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildGateSourceCleanupCommand,
  buildGateImageCommands,
  GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT,
  readGateDockerfile,
} from "../src/tools/daytona-gate-snapshot.js";
import {
  DAYTONA_GATE_IMAGE,
  DAYTONA_GATE_REGISTRY_IMAGE,
  DAYTONA_GATE_SNAPSHOT,
  LEGACY_NODE_VERSION,
  LEGACY_NPM_VERSION,
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
  assert.match(serialized, /source \/usr\/local\/nvm\/nvm\.sh/);
  assert.match(serialized, /nvm use 14\.21\.3/);
  assert.match(serialized, /6\.14\.18/);
  assert.equal(serialized.includes("claude"), false);
});

test("gate Dockerfile preinstalls legacy Node without changing the default runtime", () => {
  const dockerfile = readGateDockerfile();

  assert.match(dockerfile, /FROM daytonaio\/sandbox:0\.5\.0-slim/);
  assert.match(dockerfile, /ARG NODE_VERSION=22\.14\.0/);
  assert.match(dockerfile, /ARG LEGACY_NODE_VERSION=14\.21\.3/);
  assert.match(
    dockerfile,
    /nvm install --no-progress "\$\{LEGACY_NODE_VERSION\}"/,
  );
  assert.match(
    dockerfile,
    /\/usr\/local\/nvm\/versions\/node\/v\$\{NODE_VERSION\}\/bin/,
  );
  assert.match(
    dockerfile,
    /\/usr\/local\/nvm\/versions\/node\/v\$\{LEGACY_NODE_VERSION\}\/bin/,
  );
  assert.match(dockerfile, /test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/);
  assert.match(
    dockerfile,
    /test "\$\("\$\{legacy_node_bin\}\/node" --version\)" = "v\$\{LEGACY_NODE_VERSION\}"/,
  );
  assert.match(
    dockerfile,
    /test "\$\("\$\{legacy_node_bin\}\/npm" --version\)" = "6\.14\.18"/,
  );
  assert.match(dockerfile, /apt-get install/);
  assert.match(dockerfile, /bash/);
  assert.match(dockerfile, /python3/);
  assert.match(dockerfile, /curl/);
  assert.equal(dockerfile.includes("claude"), false);
});

test("gate snapshot preflight verifies legacy nvm use and no Claude", () => {
  assert.match(
    GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT,
    /source \/usr\/local\/nvm\/nvm\.sh/,
  );
  assert.match(
    GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT,
    new RegExp(`nvm use ${LEGACY_NODE_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.match(
    GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT,
    new RegExp(`v${LEGACY_NODE_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.match(
    GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT,
    new RegExp(LEGACY_NPM_VERSION.replaceAll(".", "\\.")),
  );
  assert.match(GATE_SNAPSHOT_TOOLCHAIN_PREFLIGHT, /! command -v claude/);
});

test("gate source cleanup preinstalls legacy Node before creating latest snapshot", () => {
  const command = buildGateSourceCleanupCommand();

  assert.match(command, /sudo rm -rf \/opt\/claude-code/);
  assert.match(command, /sudo env LEGACY_NODE_VERSION=14\.21\.3 bash -lc/);
  assert.match(command, /nvm install --no-progress "\$\{LEGACY_NODE_VERSION\}"/);
  assert.match(command, /source \/usr\/local\/nvm\/nvm\.sh/);
  assert.match(command, /nvm use 14\.21\.3/);
  assert.match(command, /! command -v claude/);
});

test("gate latest snapshot has a stable replacement target name", () => {
  assert.equal(DAYTONA_GATE_SNAPSHOT, "harness-gate-runtime-node-22.14.0-r2");
});

test("harness-prep snapshot guidance documents legacy nvm boundaries", () => {
  const docs = readFileSync(
    "plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md",
    "utf8",
  );

  assert.match(docs, /Gate source: harness-gate-runtime-node-22\.14\.0-r2/);
  assert.match(docs, /Node 14\.21\.3/);
  assert.match(docs, /npm 6\.14\.18/);
  assert.match(docs, /nvm is a shell function/);
  assert.match(docs, /\/usr\/local\/nvm.*not writable/i);
  assert.match(docs, /do not .*nvm install/i);
  assert.match(docs, /gateSetup/);
  assert.match(
    docs,
    /source \/usr\/local\/nvm\/nvm\.sh && nvm use 14\.21\.3 && npm ci/,
  );
});

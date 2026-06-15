# Daytona Claude Image And Setup Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and register a complete Daytona Agent image containing Node.js `22.14.0` and Claude Code `2.1.145`, remove runtime Claude installation, and make sandbox setup and PTY failures terminate with observable errors.

**Architecture:** Claude Agent sandboxes are created from the immutable `harness-agent-claude-2.1.145-r1` Snapshot selected by the host. Project setup uses Daytona's non-interactive command API, while PTY is reserved for the Agent and is wrapped so startup failures exit. The complete image is built inside the local Daytona runner Docker daemon, pushed to Daytona's internal registry, registered as a Snapshot, and verified by creating a temporary sandbox.

**Tech Stack:** TypeScript, Node.js 22, Node test runner, `@daytona/sdk@0.186.0`, Docker, local Daytona runner and registry, Claude Code `2.1.145`.

---

## File Structure

### Create

- `images/daytona/claude/Dockerfile`
  - Defines the complete immutable Daytona Agent image.
- `src/harness/sandbox/toolchain.ts`
  - Owns pinned tool versions, Snapshot names, preflight command, and preflight validation.
- `src/tools/daytona-agent-snapshot.ts`
  - Builds and verifies the image in the Daytona runner, pushes it to the internal registry, registers the Snapshot, and verifies a temporary sandbox.
- `test/daytona-toolchain.test.ts`
  - Tests pinned versions, preflight validation, and immutable Snapshot compatibility.
- `test/daytona-agent-snapshot.test.ts`
  - Tests image build orchestration without invoking Docker or Daytona.

### Modify

- `src/harness/sandbox/types.ts`
  - Adds host-selected Snapshot and PTY output callback fields.
- `src/harness/sandbox/daytona.ts`
  - Maps Snapshot creation, removes runtime installation constants, and hardens PTY completion.
- `src/harness/sandbox/environment.ts`
  - Requires the Claude Agent Snapshot, runs preflight and setup non-interactively, and emits lifecycle observations.
- `test/daytona-sandbox.test.ts`
  - Covers Snapshot mapping and real PTY wrapper behavior at the adapter boundary.
- `test/daytona-environment.test.ts`
  - Covers preflight, setup execution, Agent/Gate Snapshot separation, failure, and observations.
- `test/daytona-claude.test.ts`
  - Covers required Agent Snapshot configuration and stable Claude path.
- `test/daytona-claude.ts`
  - Extends the real integration flow with `agentSetup: ["npm install"]` and Snapshot assertions.
- `package.json`
  - Adds `snapshot:agent` and keeps the real integration entrypoint explicit.
- `README.md`
  - Adds the image/Snapshot prerequisite.
- `docs/daytona-local-claude-code-runbook.md`
  - Documents build, configuration, upgrade, rollback, diagnosis, and cleanup.
- `docs/archive/2026-06-15-daytona-sandbox-gate/verification.md`
  - Records the new verification evidence after execution.

---

### Task 1: Add Pinned Toolchain And Snapshot Configuration

**Files:**
- Create: `src/harness/sandbox/toolchain.ts`
- Create: `test/daytona-toolchain.test.ts`
- Modify: `src/harness/sandbox/types.ts:40-44`
- Modify: `src/harness/sandbox/daytona.ts:26-31,148-157,707-718`
- Modify: `test/daytona-sandbox.test.ts:12-23,89-132`
- Modify: `test/daytona-claude.test.ts:4-11,109-113`

- [ ] **Step 1: Write failing tests for the pinned release and Snapshot mapping**

Create `test/daytona-toolchain.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAUDE_CODE_VERSION,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_SNAPSHOT,
  NODE_VERSION,
  requireAgentSnapshot,
} from "../src/harness/sandbox/toolchain.js";

test("agent image release is pinned to the approved local toolchain", () => {
  assert.equal(NODE_VERSION, "22.14.0");
  assert.equal(CLAUDE_CODE_VERSION, "2.1.145");
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
      HARNESS_DAYTONA_AGENT_SNAPSHOT: DAYTONA_AGENT_SNAPSHOT,
    }),
    DAYTONA_AGENT_SNAPSHOT,
  );
  assert.throws(
    () => requireAgentSnapshot({}),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
});
```

Extend `test/daytona-sandbox.test.ts` so the SDK provider is expected to receive
an Agent Snapshot but no Gate Snapshot:

```ts
await provider.create({
  role: "agent",
  snapshot: "harness-agent-claude-2.1.145-r1",
  envVars: {},
  ephemeral: false,
});
await provider.create({
  role: "gate",
  envVars: {},
  ephemeral: true,
});

assert.equal(created[0]?.snapshot, "harness-agent-claude-2.1.145-r1");
assert.equal(created[1]?.snapshot, undefined);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build
```

Expected: TypeScript compilation fails because `toolchain.ts` and
`SandboxCreateRequest.snapshot` do not exist.

- [ ] **Step 3: Implement pinned constants and Snapshot request mapping**

Create `src/harness/sandbox/toolchain.ts`:

```ts
export const NODE_VERSION = "22.14.0";
export const CLAUDE_CODE_VERSION = "2.1.145";
export const DAYTONA_AGENT_RELEASE = `${CLAUDE_CODE_VERSION}-r1`;
export const DAYTONA_AGENT_IMAGE =
  `harness-daytona-claude:${DAYTONA_AGENT_RELEASE}`;
export const DAYTONA_AGENT_REGISTRY_IMAGE =
  `registry:6000/harness/${DAYTONA_AGENT_IMAGE}`;
export const DAYTONA_AGENT_SNAPSHOT =
  `harness-agent-claude-${DAYTONA_AGENT_RELEASE}`;

type Environment = Record<string, string | undefined>;

export function requireAgentSnapshot(environment: Environment): string {
  const snapshot = environment.HARNESS_DAYTONA_AGENT_SNAPSHOT?.trim();
  if (!snapshot) {
    throw new Error(
      "Missing required environment variable: " +
        "HARNESS_DAYTONA_AGENT_SNAPSHOT",
    );
  }
  return snapshot;
}
```

Add the optional Snapshot to `SandboxCreateRequest`:

```ts
export interface SandboxCreateRequest {
  role: "agent" | "gate";
  snapshot?: string;
  envVars: Record<string, string>;
  ephemeral: boolean;
}
```

Extend `DaytonaSdkClient.create` and `DaytonaSdkProvider.create`:

```ts
export interface DaytonaSdkClient {
  create(params: {
    language: string;
    snapshot?: string;
    labels: Record<string, string>;
    envVars: Record<string, string>;
    ephemeral: boolean;
    networkBlockAll: boolean;
  }): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
}

const sandbox = await this.client.create({
  language: "typescript",
  ...(request.snapshot ? { snapshot: request.snapshot } : {}),
  labels: { "harness.role": request.role },
  envVars: request.envVars,
  ephemeral: request.ephemeral,
  networkBlockAll: false,
});
```

Replace the Claude launch path in `src/harness/sandbox/daytona.ts`:

```ts
export const CLAUDE_COMMAND =
  'exec "/usr/local/bin/claude" --dangerously-skip-permissions ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';
```

Delete `CLAUDE_INSTALL_COMMAND` and update
`test/daytona-claude.test.ts` to assert the stable image path:

```ts
test("Claude Code launches from the immutable image path", () => {
  assert.match(CLAUDE_COMMAND, /^exec "\/usr\/local\/bin\/claude"/);
  assert.match(CLAUDE_COMMAND, /--dangerously-skip-permissions/);
});
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-toolchain.test.js
node --test dist/test/daytona-sandbox.test.js
node --test dist/test/daytona-claude.test.js
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/harness/sandbox/toolchain.ts src/harness/sandbox/types.ts \
  src/harness/sandbox/daytona.ts test/daytona-toolchain.test.ts \
  test/daytona-sandbox.test.ts test/daytona-claude.test.ts
git commit -m "feat: select pinned Daytona Agent snapshot"
```

---

### Task 2: Add Toolchain Preflight And Non-Interactive Setup

**Files:**
- Modify: `src/harness/sandbox/toolchain.ts`
- Modify: `src/harness/sandbox/environment.ts:7-12,54-75,77-127,198-235`
- Modify: `test/daytona-toolchain.test.ts`
- Modify: `test/daytona-environment.test.ts:67-265,326-369`

- [ ] **Step 1: Write failing preflight and setup tests**

Add to `test/daytona-toolchain.test.ts`:

```ts
import {
  assertClaudeToolchain,
  CLAUDE_TOOLCHAIN_PREFLIGHT,
} from "../src/harness/sandbox/toolchain.js";

test("preflight accepts the exact image toolchain", () => {
  assert.doesNotThrow(() =>
    assertClaudeToolchain({
      exitCode: 0,
      stdout:
        "node=v22.14.0\nnpm=10.9.2\nnpx=10.9.2\n" +
        "claude=2.1.145 (Claude Code)\n",
      stderr: "",
    })
  );
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/node/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/npm/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/npx/);
  assert.match(CLAUDE_TOOLCHAIN_PREFLIGHT, /\/usr\/local\/bin\/claude/);
});

test("preflight rejects missing or drifted tool versions", () => {
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 127,
        stdout: "",
        stderr: "claude: not found",
      }),
    /preflight failed.*claude: not found/i,
  );
  assert.throws(
    () =>
      assertClaudeToolchain({
        exitCode: 0,
        stdout:
          "node=v22.14.0\nnpm=10.9.2\nnpx=10.9.2\n" +
          "claude=2.1.177 (Claude Code)\n",
        stderr: "",
      }),
    /expected Claude Code 2\.1\.145.*2\.1\.177/i,
  );
});
```

Add an environment test with `agentSetup: ["npm install", "npm test"]`.
Assert:

```ts
assert.deepEqual(agent.commands.slice(0, 3), [
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  "npm install",
  "npm test",
]);
assert.equal(agent.ptyCommands.includes("npm install"), false);
```

Add a setup failure test where the recording handle returns exit `127` for
`npm install`; assert that `npm test` and the Agent PTY never run and that the
Agent sandbox is deleted.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build
```

Expected: compilation fails because `CLAUDE_TOOLCHAIN_PREFLIGHT` and
`assertClaudeToolchain` do not exist.

- [ ] **Step 3: Implement preflight validation**

Add to `src/harness/sandbox/toolchain.ts`:

```ts
import type { SandboxCommandResult } from "./types.js";

export const CLAUDE_TOOLCHAIN_PREFLIGHT = [
  "set -eu",
  'node_version=$("/usr/local/bin/node" --version)',
  'npm_version=$("/usr/local/bin/npm" --version)',
  'npx_version=$("/usr/local/bin/npx" --version)',
  'claude_version=$("/usr/local/bin/claude" --version)',
  'printf "node=%s\\nnpm=%s\\nnpx=%s\\nclaude=%s\\n" ' +
    '"$node_version" "$npm_version" "$npx_version" "$claude_version"',
].join("; ");

export function assertClaudeToolchain(
  result: SandboxCommandResult,
): void {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `Claude toolchain preflight failed with exit ${result.exitCode}: ` +
        (output || "(no output)"),
    );
  }
  const node = /^node=v?([^\s]+)$/m.exec(result.stdout)?.[1];
  const npm = /^npm=([^\s]+)$/m.exec(result.stdout)?.[1];
  const npx = /^npx=([^\s]+)$/m.exec(result.stdout)?.[1];
  const claude = /^claude=([^\s]+)/m.exec(result.stdout)?.[1];
  if (node !== NODE_VERSION) {
    throw new Error(
      `Expected Node.js ${NODE_VERSION}, observed ${node ?? "missing"}`,
    );
  }
  if (!npm || !npx) {
    throw new Error(
      `Expected npm and npx in the Agent image, observed ` +
        `npm=${npm ?? "missing"} npx=${npx ?? "missing"}`,
    );
  }
  if (claude !== CLAUDE_CODE_VERSION) {
    throw new Error(
      `Expected Claude Code ${CLAUDE_CODE_VERSION}, ` +
        `observed ${claude ?? "missing"}`,
    );
  }
}
```

- [ ] **Step 4: Change setup to `execute` and remove runtime installation**

In `src/harness/sandbox/environment.ts`, replace `runSetup` with:

```ts
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

async function runSetup(
  handle: SandboxHandle,
  commands: string[],
  label: string,
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const result = await handle.execute(
      command,
      REMOTE_ROOT,
      {},
      SETUP_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw commandFailure(`${label} command ${index + 1}`, result);
    }
  }
}
```

In the Claude Agent initialization path:

```ts
const preflight = await handle.execute(
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  REMOTE_ROOT,
  {},
  30_000,
);
assertClaudeToolchain(preflight);
await runSetup(handle, options.policy.agentSetup, "agent setup");
```

Delete every call to `CLAUDE_INSTALL_COMMAND`. Gate setup also continues through
the same non-interactive `runSetup`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-toolchain.test.js
node --test dist/test/daytona-environment.test.js
```

Expected: tests pass and setup commands appear only in `commands`, never in
`ptyCommands`.

- [ ] **Step 6: Commit**

```bash
git add src/harness/sandbox/toolchain.ts src/harness/sandbox/environment.ts \
  test/daytona-toolchain.test.ts test/daytona-environment.test.ts
git commit -m "fix: run sandbox setup without PTY"
```

---

### Task 3: Require Agent Snapshot And Preserve Gate Isolation

**Files:**
- Modify: `src/harness/sandbox/environment.ts:77-103,198-207`
- Modify: `src/harness/sandbox/daytona.ts:737-759`
- Modify: `test/daytona-environment.test.ts`
- Modify: `test/daytona-sandbox.test.ts:48-87`

- [ ] **Step 1: Write failing Snapshot separation tests**

Add an environment test that creates a Claude run with:

```ts
environment: {
  ...modelEnvironment,
  HARNESS_DAYTONA_AGENT_SNAPSHOT:
    "harness-agent-claude-2.1.145-r1",
},
```

Assert:

```ts
const agentRequest = provider.requests.find(({ role }) => role === "agent");
const gateRequest = provider.requests.find(({ role }) => role === "gate");
assert.equal(
  agentRequest?.snapshot,
  "harness-agent-claude-2.1.145-r1",
);
assert.equal(gateRequest?.snapshot, undefined);
```

Add a test asserting that constructing a Claude environment without
`HARNESS_DAYTONA_AGENT_SNAPSHOT` throws before `provider.create` is called.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js
```

Expected: the Agent request has no Snapshot and the missing-variable test does
not throw.

- [ ] **Step 3: Implement host-selected Agent Snapshot**

At environment construction:

```ts
const runtimeEnvironment = options.environment ?? process.env;
const modelEnvironment = options.agent.kind === "claude"
  ? getClaudeEnvironment(runtimeEnvironment)
  : {};
const agentSnapshot = options.agent.kind === "claude"
  ? requireAgentSnapshot(runtimeEnvironment)
  : undefined;
```

At Agent creation:

```ts
const handle = await options.provider.create({
  role: "agent",
  ...(agentSnapshot ? { snapshot: agentSnapshot } : {}),
  envVars: {},
  ephemeral: false,
});
```

Do not add a Snapshot to the Gate request.

Update `createDaytonaManager` so `createAgentSandbox` includes the configured
Snapshot only when present, while `createGateSandbox` never does:

```ts
const snapshot = environment.HARNESS_DAYTONA_AGENT_SNAPSHOT?.trim();

createAgentSandbox() {
  return provider.create({
    role: "agent",
    ...(snapshot ? { snapshot } : {}),
    envVars: {},
    ephemeral: false,
  });
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
node --test dist/test/daytona-sandbox.test.js
```

Expected: all Snapshot separation tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/harness/sandbox/environment.ts src/harness/sandbox/daytona.ts \
  test/daytona-environment.test.ts test/daytona-sandbox.test.ts
git commit -m "feat: isolate Agent and Gate snapshots"
```

---

### Task 4: Make PTY Failures Exit And Surface Bounded Output

**Files:**
- Modify: `src/harness/sandbox/types.ts:68-74`
- Modify: `src/harness/sandbox/daytona.ts:500-570`
- Modify: `test/daytona-sandbox.test.ts:360-424,571-705`

- [ ] **Step 1: Write failing PTY wrapper and timeout tests**

Extend the fake PTY to record output callbacks and add:

```ts
test("SDK handle wraps PTY commands so lookup failure exits the shell", async () => {
  const sdkSandbox = fakeSdkSandbox({ ptyExitCode: 127 });
  const provider = createDaytonaSdkProviderFromClient(
    fakeSdkClient(sdkSandbox),
  );
  const handle = await provider.create({
    role: "agent",
    envVars: {},
    ephemeral: false,
  });

  await handle.runPty("missing-command", "/workspace/candidate", {});

  assert.deepEqual(sdkSandbox.calls.ptyInputs, [
    "{ missing-command; }; status=$?; exit \"$status\"\n",
  ]);
});
```

Change the timeout test to emit `"npm: not found\n"` before waiting forever and
assert:

```ts
await assert.rejects(
  () => handle.runPty("npm install", "/workspace/candidate", {}, 10),
  /PTY timed out.*npm: not found/s,
);
```

Add a test that the optional output callback receives the same bounded chunks
that are retained in `stdout`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js
```

Expected: the wrapper assertion fails because the current input is
`exec missing-command\n`; the timeout error lacks captured output.

- [ ] **Step 3: Extend the PTY interface**

Add the optional callback:

```ts
runPty(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs?: number,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<SandboxCommandResult>;
```

- [ ] **Step 4: Implement terminal wrapper and bounded error tail**

In `DaytonaSandboxHandle.runPty`:

```ts
const outputTail = () =>
  Buffer.concat(chunks).toString("utf8").slice(-4096);

// Inside onData, after the size check:
chunks.push(chunk);
onOutput?.(chunk.toString("utf8"));

const shellCommand =
  `{ ${command}; }; status=$?; exit "$status"\n`;
await Promise.race([pty.sendInput(shellCommand), interruption]);
```

When timeout or cancellation occurs, await `pty.kill()` and throw an error that
includes the bounded tail:

```ts
} catch (error) {
  if (terminalError) {
    await pty?.kill().catch(() => undefined);
    const detail = outputTail().trim();
    throw new Error(
      `${terminalError.message}` +
        `${detail ? `\nPTY output tail:\n${detail}` : ""}`,
    );
  }
  throw error;
} finally {
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  await pty?.disconnect();
}
```

The `interrupt` helper sets `terminalError` and rejects the interruption
promise; it must not fire-and-forget the kill operation because the catch block
owns the awaited cleanup.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js
```

Expected: PTY wrapper, output callback, timeout, kill, and disconnect tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/sandbox/types.ts src/harness/sandbox/daytona.ts \
  test/daytona-sandbox.test.ts
git commit -m "fix: terminate failed Daytona PTY commands"
```

---

### Task 5: Add Lifecycle Observability With Credential Redaction

**Files:**
- Create: `src/harness/sandbox/observability.ts`
- Create: `test/daytona-observability.test.ts`
- Modify: `src/harness/sandbox/environment.ts:77-250`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing redaction and lifecycle tests**

Create `test/daytona-observability.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLineRedactor,
  redactSecrets,
  sanitizeObservation,
} from "../src/harness/sandbox/observability.js";

test("redacts every configured secret", () => {
  assert.equal(
    redactSecrets("token=secret-token", ["secret-token"]),
    "token=[REDACTED]",
  );
});

test("line redactor handles secrets split across PTY chunks", () => {
  const output: string[] = [];
  const redactor = createLineRedactor(["secret-token"], (line) =>
    output.push(line)
  );
  redactor.write("token=secret-");
  redactor.write("token\nnext\n");
  redactor.flush();
  assert.deepEqual(output, ["token=[REDACTED]\n", "next\n"]);
});

test("recursively redacts observation payloads", () => {
  assert.deepEqual(
    sanitizeObservation(
      { error: "failed with secret-token", nested: ["secret-token"] },
      ["secret-token"],
    ),
    { error: "failed with [REDACTED]", nested: ["[REDACTED]"] },
  );
});
```

Add an environment test collecting observations and assert ordered events:

```ts
assert.deepEqual(
  observations.map(([event]) => event),
  [
    "agent.create.start",
    "agent.create.end",
    "agent.upload.start",
    "agent.upload.end",
    "agent.preflight.start",
    "agent.preflight.end",
    "agent.setup.start",
    "agent.setup.end",
    "agent.command.start",
    "agent.command.output",
    "agent.command.end",
  ],
);
assert.equal(JSON.stringify(observations).includes("test-token"), false);
```

Add failure tests for `agent.setup.fail` and `gate.verify.fail`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build
```

Expected: compilation fails because `observability.ts` does not exist.

- [ ] **Step 3: Implement line-based secret redaction**

Create `src/harness/sandbox/observability.ts`:

```ts
export function redactSecrets(
  value: string,
  secrets: string[],
): string {
  return secrets
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value,
    );
}

export function createLineRedactor(
  secrets: string[],
  emit: (line: string) => void,
) {
  let pending = "";
  return {
    write(chunk: string) {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        emit(redactSecrets(line, secrets));
      }
    },
    flush() {
      if (pending) emit(redactSecrets(pending, secrets));
      pending = "";
    },
  };
}

export function sanitizeObservation(
  value: unknown,
  secrets: string[],
): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeObservation(entry, secrets));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeObservation(entry, secrets),
      ]),
    );
  }
  return value;
}
```

- [ ] **Step 4: Emit phase start/end/fail observations**

Add a small phase helper in `environment.ts`:

```ts
async function observedPhase<T>(
  observe: (event: string, data: unknown) => void,
  name: string,
  data: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  observe(`${name}.start`, data);
  try {
    const result = await operation();
    observe(`${name}.end`, {
      ...data,
      durationMs: performance.now() - startedAt,
    });
    return result;
  } catch (error) {
    observe(`${name}.fail`, {
      ...data,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

Use it for Agent create/upload/preflight/setup/command and Gate
create/setup/verify. For Claude PTY output, create a line redactor from
`Object.values(modelEnvironment)` and emit:

```ts
const output = createLineRedactor(
  Object.values(modelEnvironment),
  (line) => observe("agent.command.output", { line }),
);
result = await handle.runPty(
  CLAUDE_COMMAND,
  REMOTE_ROOT,
  { ...modelEnvironment, HARNESS_PROMPT: prompt },
  undefined,
  undefined,
  (chunk) => output.write(chunk),
);
output.flush();
```

Route every observation through recursive sanitization:

```ts
const observationSecrets = Object.values(modelEnvironment);
const observe = (event: string, data: unknown) => {
  options.onObservation?.(
    event,
    sanitizeObservation(data, observationSecrets),
  );
};
```

Do not put command environment values in observation payloads.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-observability.test.js
node --test dist/test/daytona-environment.test.js
```

Expected: lifecycle and redaction tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/sandbox/observability.ts \
  src/harness/sandbox/environment.ts \
  test/daytona-observability.test.ts test/daytona-environment.test.ts
git commit -m "feat: report Daytona lifecycle progress"
```

---

### Task 6: Build The Complete Claude Image And Register The Snapshot

**Files:**
- Create: `images/daytona/claude/Dockerfile`
- Create: `src/tools/daytona-agent-snapshot.ts`
- Create: `test/daytona-agent-snapshot.test.ts`
- Modify: `package.json:16-22`

- [ ] **Step 1: Write failing image plan tests**

Create `test/daytona-agent-snapshot.test.ts` with an injected command runner:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildImageCommands,
  assertCompatibleSnapshot,
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
      ["docker", ["exec", "daytona-runner-1", "sh", "-lc",
        "rm -rf /tmp/context && mkdir -p /tmp/context"]],
      ["docker", ["cp", "images/daytona/claude/.",
        "daytona-runner-1:/tmp/context"]],
      ["docker", ["exec", "daytona-runner-1", "docker", "build",
        "--pull=false", "-t", DAYTONA_AGENT_IMAGE, "/tmp/context"]],
      ["docker", ["exec", "daytona-runner-1", "docker", "run", "--rm",
        "--entrypoint", "/bin/sh", DAYTONA_AGENT_IMAGE, "-lc",
        "node --version && npm --version && npx --version && claude --version"]],
      ["docker", ["exec", "daytona-runner-1", "docker", "tag",
        DAYTONA_AGENT_IMAGE, DAYTONA_AGENT_REGISTRY_IMAGE]],
      ["docker", ["exec", "daytona-runner-1", "docker", "push",
        DAYTONA_AGENT_REGISTRY_IMAGE]],
    ],
  );
});

test("existing Snapshot must match the immutable registry image", () => {
  assert.doesNotThrow(() =>
    assertCompatibleSnapshot({
      name: DAYTONA_AGENT_SNAPSHOT,
      imageName: DAYTONA_AGENT_REGISTRY_IMAGE,
      state: "inactive",
    })
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
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build
```

Expected: compilation fails because the Snapshot tool does not exist.

- [ ] **Step 3: Create the complete Docker image**

Create `images/daytona/claude/Dockerfile`:

```dockerfile
FROM daytonaio/sandbox:0.5.0-slim

ARG NODE_VERSION=22.14.0
ARG CLAUDE_CODE_VERSION=2.1.145

USER root

RUN set -eux; \
    node_bin="/usr/local/nvm/versions/node/v${NODE_VERSION}/bin"; \
    test -x "${node_bin}/node"; \
    test -x "${node_bin}/npm"; \
    test -x "${node_bin}/npx"; \
    ln -sf "${node_bin}/node" /usr/local/bin/node; \
    ln -sf "${node_bin}/npm" /usr/local/bin/npm; \
    ln -sf "${node_bin}/npx" /usr/local/bin/npx; \
    npm install --global --prefix /usr/local \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$(claude --version | awk '{print $1}')" = \
      "${CLAUDE_CODE_VERSION}"

ENV PATH="/usr/local/bin:/usr/local/nvm/versions/node/v22.14.0/bin:${PATH}"

USER daytona
```

- [ ] **Step 4: Implement build, push, Snapshot registration, and sandbox preflight**

Create `src/tools/daytona-agent-snapshot.ts` with:

```ts
import { spawnSync } from "node:child_process";
import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";
import { pathToFileURL } from "node:url";

import {
  assertClaudeToolchain,
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_SNAPSHOT,
} from "../harness/sandbox/toolchain.js";
import {
  configureLocalDaytonaProxy,
  getDaytonaConfig,
} from "../harness/sandbox/daytona.js";

type SnapshotIdentity = {
  name: string;
  imageName?: string;
  state: string;
};

export function assertCompatibleSnapshot(
  snapshot: SnapshotIdentity,
): void {
  if (snapshot.imageName !== DAYTONA_AGENT_REGISTRY_IMAGE) {
    throw new Error(
      `Existing immutable Snapshot ${snapshot.name} does not match ` +
        `${DAYTONA_AGENT_REGISTRY_IMAGE}; publish a new revision such as r2`,
    );
  }
}

export function buildImageCommands(
  runner: string,
  context: string,
): Array<[string, string[]]> {
  return [
    ["docker", ["exec", runner, "sh", "-lc",
      `rm -rf ${context} && mkdir -p ${context}`]],
    ["docker", ["cp", "images/daytona/claude/.",
      `${runner}:${context}`]],
    ["docker", ["exec", runner, "docker", "build", "--pull=false",
      "-t", DAYTONA_AGENT_IMAGE, context]],
    ["docker", ["exec", runner, "docker", "run", "--rm",
      "--entrypoint", "/bin/sh", DAYTONA_AGENT_IMAGE, "-lc",
      "node --version && npm --version && npx --version && claude --version"]],
    ["docker", ["exec", runner, "docker", "tag",
      DAYTONA_AGENT_IMAGE, DAYTONA_AGENT_REGISTRY_IMAGE]],
    ["docker", ["exec", runner, "docker", "push",
      DAYTONA_AGENT_REGISTRY_IMAGE]],
  ];
}
```

The executable path must then:

1. set `runner = process.env.DAYTONA_RUNNER_CONTAINER ||
   "daytona-runner-1"`;
2. create a unique `/tmp/harness-agent-image-${process.pid}` context;
3. execute every command with `spawnSync(..., { stdio: "inherit" })` and fail
   on a nonzero status;
4. remove the remote context in `finally`;
5. configure local proxy bypass and create `new Daytona(getDaytonaConfig(...))`;
6. call `snapshot.get(DAYTONA_AGENT_SNAPSHOT)`;
7. on `DaytonaNotFoundError`, call:

```ts
await daytona.snapshot.create({
  name: DAYTONA_AGENT_SNAPSHOT,
  image: DAYTONA_AGENT_REGISTRY_IMAGE,
}, {
  timeout: 10 * 60,
  onLogs: (line) => console.log(line),
});
```

8. validate an existing Snapshot with `assertCompatibleSnapshot`;
9. when the compatible Snapshot is inactive, call
   `daytona.snapshot.activate(snapshot)`, then poll `snapshot.get(name)` until
   state is `active` or a two-minute deadline expires;
10. reject `error`, `build_failed`, or any deadline expiry with the Snapshot's
    `errorReason`;
11. create a temporary sandbox with
   `{ snapshot: DAYTONA_AGENT_SNAPSHOT, ephemeral: true }`;
12. run `CLAUDE_TOOLCHAIN_PREFLIGHT`, call `assertClaudeToolchain`, then delete
    the temporary sandbox in `finally`;
13. print:

```text
export HARNESS_DAYTONA_AGENT_SNAPSHOT=harness-agent-claude-2.1.145-r1
```

- [ ] **Step 5: Add the package command**

Add:

```json
"snapshot:agent": "npm run build && node dist/src/tools/daytona-agent-snapshot.js"
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-agent-snapshot.test.js
node --test dist/test/daytona-toolchain.test.js
docker build --check images/daytona/claude
```

Expected: TypeScript tests pass and Dockerfile validation exits zero. If the
installed Docker version does not support `docker build --check`, run:

```bash
docker build --no-cache --progress=plain \
  -t harness-daytona-claude:plan-check \
  images/daytona/claude
```

and remove only the `plan-check` tag afterward.

- [ ] **Step 7: Commit**

```bash
git add images/daytona/claude/Dockerfile \
  src/tools/daytona-agent-snapshot.ts \
  test/daytona-agent-snapshot.test.ts package.json
git commit -m "feat: build pinned Daytona Claude snapshot"
```

---

### Task 7: Extend The Real Daytona Integration Test

**Files:**
- Modify: `test/daytona-claude.ts:41-117`
- Modify: `test/daytona-claude.test.ts`

- [ ] **Step 1: Write failing integration configuration tests**

Add a pure helper in `test/daytona-claude.ts`:

```ts
export function integrationPolicy() {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src", "package.json", "package-lock.json"],
      protectedPaths: ["contracts", ".harness"],
      agentSetup: ["npm install"],
      retainOnFailure: false,
    },
  });
}
```

Add to `test/daytona-claude.test.ts`:

```ts
import { integrationPolicy } from "./daytona-claude.js";

test("real Daytona integration exercises non-interactive npm setup", () => {
  assert.deepEqual(integrationPolicy().agentSetup, ["npm install"]);
});
```

Add a request recorder to the integration provider and assert:

```ts
const agent = requests.find(({ role }) => role === "agent");
const gate = requests.find(({ role }) => role === "gate");
assert.equal(
  agent?.snapshot,
  environment.HARNESS_DAYTONA_AGENT_SNAPSHOT,
);
assert.equal(gate?.snapshot, undefined);
```

- [ ] **Step 2: Run unit tests and verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-claude.test.js
```

Expected: `integrationPolicy` is missing or `agentSetup` is empty.

- [ ] **Step 3: Implement the integration fixture**

Change the temporary fixture to include:

```json
{
  "name": "harness-daytona-integration",
  "version": "1.0.0",
  "private": true
}
```

Use `integrationPolicy()` and record complete `SandboxCreateRequest` objects,
not only roles. Keep the exact candidate/gate verification and cleanup checks.

Before running the loop, require:

```ts
if (!environment.HARNESS_DAYTONA_AGENT_SNAPSHOT) {
  throw new Error(
    "Missing HARNESS_DAYTONA_AGENT_SNAPSHOT for Daytona integration",
  );
}
```

- [ ] **Step 4: Run the unit test and verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-claude.test.js
```

Expected: test passes without contacting Daytona.

- [ ] **Step 5: Commit**

```bash
git add test/daytona-claude.ts test/daytona-claude.test.ts
git commit -m "test: cover Daytona Agent setup integration"
```

---

### Task 8: Update Documentation And Operator Commands

**Files:**
- Modify: `README.md:8-36`
- Modify: `docs/daytona-local-claude-code-runbook.md`
- Modify: `docs/archive/2026-06-15-daytona-sandbox-gate/verification.md`

- [ ] **Step 1: Update the required environment**

Add:

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r1"
```

State explicitly that the Snapshot is host-selected and Gate sandboxes do not
inherit it.

- [ ] **Step 2: Document image and Snapshot generation**

Add:

```bash
source ~/.zshrc
npm run snapshot:agent
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r1"
```

Document the generated artifacts:

```text
harness-daytona-claude:2.1.145-r1
registry:6000/harness/harness-daytona-claude:2.1.145-r1
harness-agent-claude-2.1.145-r1
```

- [ ] **Step 3: Document upgrade, rollback, diagnosis, and cleanup**

Upgrade requires changing both pinned constants and creating `r2`; never
overwrite `r1`. Rollback means selecting the old Snapshot environment value.

Include diagnosis commands:

```bash
docker exec daytona-runner-1 docker images \
  'registry:6000/harness/harness-daytona-claude'
npm run snapshot:agent
npm run test:daytona
```

Cleanup documentation must warn operators to remove old Snapshots only after
confirming no active run references them.

- [ ] **Step 4: Verify documentation references**

Run:

```bash
rg -n "2\\.1\\.145|22\\.14\\.0|HARNESS_DAYTONA_AGENT_SNAPSHOT|snapshot:agent" \
  README.md docs package.json images src test
git diff --check
```

Expected: all required release and configuration references are present and
there are no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/daytona-local-claude-code-runbook.md \
  docs/archive/2026-06-15-daytona-sandbox-gate/verification.md
git commit -m "docs: add Daytona Claude snapshot operations"
```

---

### Task 9: Build The Actual Image, Register Snapshot, And Verify End To End

**Files:**
- Modify only if evidence differs:
  `docs/archive/2026-06-15-daytona-sandbox-gate/verification.md`

- [ ] **Step 1: Run the full offline verification**

Run:

```bash
npm run check
```

Expected: build succeeds and every unit test passes with zero failures.

- [ ] **Step 2: Generate the complete image and Snapshot**

Run:

```bash
source ~/.zshrc
npm run snapshot:agent
```

Expected evidence:

- image `harness-daytona-claude:2.1.145-r1` exists in the runner daemon;
- registry image
  `registry:6000/harness/harness-daytona-claude:2.1.145-r1` is pushed;
- Snapshot `harness-agent-claude-2.1.145-r1` is active;
- temporary sandbox reports Node `v22.14.0`;
- temporary sandbox reports Claude Code `2.1.145`;
- temporary sandbox is deleted.

- [ ] **Step 3: Run the real Agent/Gate integration**

Run:

```bash
source ~/.zshrc
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r1"
npm run test:daytona
```

Expected:

```text
agent.preflight.end
agent.setup.end
agent.command.end
gate.verify.end
PASS Daytona agent/gate integration
```

No runtime `npm install -g @anthropic-ai/claude-code` occurs.

- [ ] **Step 4: Rerun the original user scenario**

Run:

```bash
cd /Users/zhongyy40/workspace/test_harness
source ~/.zshrc
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r1"
node /Users/zhongyy40/workspace/harnesscli/harness/dist/src/cli.js \
  run \
  --driver claude \
  --dir contracts \
  "按 docs/plans/file-server-build.md 实现文件上传服务器"
```

Expected:

- the CLI prints create, upload, preflight, and setup progress;
- `npm install` completes through `executeCommand`;
- Claude starts from `/usr/local/bin/claude`;
- Gate decisions remain outside both sandboxes;
- the run either passes or returns actionable contract feedback, but does not
  silently wait in an interactive shell.

- [ ] **Step 5: Verify trust boundary and cleanup**

List labeled sandboxes and confirm no unexpected retained Gate sandbox remains.
Inspect the Gate sandbox request evidence from the integration test and confirm:

```text
snapshot is unset
model environment is empty
Claude installation is absent
network is blocked before contract execution
```

- [ ] **Step 6: Record fresh verification evidence**

Update the verification archive with:

- full `npm run check` pass count;
- image ID and registry tag;
- Snapshot name and state;
- temporary preflight versions;
- real integration result;
- original scenario result;
- remaining limitations, if any.

- [ ] **Step 7: Run final verification after documentation updates**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: all tests pass, no whitespace errors, and only intentional files are
modified.

- [ ] **Step 8: Commit verification evidence**

```bash
git add docs/archive/2026-06-15-daytona-sandbox-gate/verification.md
git commit -m "test: verify pinned Daytona Claude image"
```

---

## Completion Criteria

- Claude Agent sandbox creation fails before Daytona access when
  `HARNESS_DAYTONA_AGENT_SNAPSHOT` is absent.
- Agent sandbox uses `harness-agent-claude-2.1.145-r1`.
- Gate sandbox never uses the Agent Snapshot or model credentials.
- Node.js `22.14.0` and Claude Code `2.1.145` are installed in the image.
- Harness never installs Claude Code during `harness run`.
- `agentSetup` and `gateSetup` use non-interactive command execution.
- PTY startup/lookup failures exit and report bounded output.
- Lifecycle progress is visible without exposing configured secrets.
- `npm run check`, `npm run snapshot:agent`, and `npm run test:daytona` pass.
- The original file-server scenario no longer stalls at `agent.create.start`.

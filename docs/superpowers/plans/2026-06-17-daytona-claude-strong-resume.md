# Daytona Claude Strong Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Daytona Claude retries strongly resume the original Claude session after gate failure.

**Architecture:** Keep the existing persistent agent sandbox and fresh-per-attempt gate sandbox model. Add a small Claude command/session layer in the Daytona adapter, keep `CLAUDE_CONFIG_DIR` stable for the whole harness run, and make `createDaytonaRunEnvironment()` fail closed unless later Claude attempts can resume the captured session id.

**Tech Stack:** TypeScript, Node.js `node:test`, Daytona SDK adapter, existing Harness `RunEnvironment` abstraction.

---

## File Structure

- Modify `src/harness/sandbox/daytona.ts`: add Claude command builder and stream-json session id parser.
- Modify `src/harness/observability.ts`: change mounted Claude config paths from attempt-scoped to run-scoped.
- Modify `src/harness/sandbox/environment.ts`: store Claude session id in the run environment and use resume command after the first attempt.
- Modify `src/harness/record.ts`: persist Claude session/resume metadata in the host run manifest.
- Modify `test/daytona-environment.test.ts`: update the fake Daytona provider and add focused retry/resume tests.
- Modify `test/observability.test.ts`: add run-recorder assertions for session/resume metadata.
- Create `test/daytona-claude-resume.test.ts`: fast unit tests for command building and session parsing.
- Modify `README.md`, `docs/architecture/daytona-sandbox-gate.md`, `docs/architecture/daytona-langfuse-observability.md`, and `docs/daytona-local-claude-code-runbook.md`: document strong resume and per-run `.claude` isolation.

## Task 1: Claude command builder and session parser

**Files:**
- Create: `test/daytona-claude-resume.test.ts`
- Modify: `src/harness/sandbox/daytona.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/daytona-claude-resume.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_COMMAND,
  buildClaudeCommand,
  parseClaudeSessionId,
} from "../src/harness/sandbox/daytona.js";

test("buildClaudeCommand returns the initial command without a session id", () => {
  assert.equal(buildClaudeCommand(), CLAUDE_COMMAND);
  assert.equal(
    buildClaudeCommand(),
    'exec "/usr/local/bin/claude" --dangerously-skip-permissions ' +
      '-p "$HARNESS_PROMPT" --output-format stream-json --verbose',
  );
});

test("buildClaudeCommand resumes through an env-provided session id", () => {
  assert.equal(
    buildClaudeCommand("session-123"),
    'exec "/usr/local/bin/claude" --dangerously-skip-permissions ' +
      '--resume "$HARNESS_CLAUDE_SESSION_ID" ' +
      '-p "$HARNESS_PROMPT" --output-format stream-json --verbose',
  );
});

test("buildClaudeCommand rejects unsafe session ids before command selection", () => {
  for (const value of ["", "   ", "abc\u0000def", "abc\ndef"]) {
    assert.throws(
      () => buildClaudeCommand(value),
      /Claude session id/i,
      `expected unsafe value ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("parseClaudeSessionId extracts the first safe stream-json session id", () => {
  assert.equal(
    parseClaudeSessionId([
      JSON.stringify({ type: "system", cwd: "/workspace/candidate" }),
      JSON.stringify({ type: "result", session_id: "session-abc" }),
    ].join("\n")),
    "session-abc",
  );
  assert.equal(
    parseClaudeSessionId(JSON.stringify({
      type: "result",
      sessionId: "session-camel",
    })),
    "session-camel",
  );
});

test("parseClaudeSessionId ignores non-json lines and unsafe session ids", () => {
  assert.equal(
    parseClaudeSessionId([
      "locale warning",
      JSON.stringify({ type: "result", session_id: "bad\nid" }),
      JSON.stringify({ type: "result", session_id: "session-safe" }),
    ].join("\n")),
    "session-safe",
  );
  assert.equal(parseClaudeSessionId("plain text only"), undefined);
});
```

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: TypeScript build fails because `buildClaudeCommand` and
`parseClaudeSessionId` are not exported.

- [ ] **Step 3: Implement minimal command builder and parser**

In `src/harness/sandbox/daytona.ts`, replace the current `CLAUDE_COMMAND`
definition with:

```ts
const CLAUDE_BASE_COMMAND =
  'exec "/usr/local/bin/claude" --dangerously-skip-permissions ';

export const CLAUDE_COMMAND =
  CLAUDE_BASE_COMMAND +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';

export const CLAUDE_RESUME_COMMAND =
  CLAUDE_BASE_COMMAND +
  '--resume "$HARNESS_CLAUDE_SESSION_ID" ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';
```

Add these helpers near the command constants:

```ts
function isSafeClaudeSessionId(value: string): boolean {
  return value.trim() === value &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function assertSafeClaudeSessionId(value: string): void {
  if (!isSafeClaudeSessionId(value)) {
    throw new Error("Claude session id must be a non-empty safe string");
  }
}

export function buildClaudeCommand(sessionId?: string): string {
  if (sessionId === undefined) return CLAUDE_COMMAND;
  assertSafeClaudeSessionId(sessionId);
  return CLAUDE_RESUME_COMMAND;
}

export function parseClaudeSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const candidate = record.session_id ?? record.sessionId;
    if (
      typeof candidate === "string" &&
      isSafeClaudeSessionId(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: all tests in `daytona-claude-resume.test.js` pass.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/harness/sandbox/daytona.ts test/daytona-claude-resume.test.ts
git commit -m "feat: add Claude resume command helpers"
```

## Task 2: Stable per-run Claude observability paths

**Files:**
- Modify: `src/harness/observability.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Update the existing observability test for RED**

In `test/daytona-environment.test.ts`, update the test named
`Claude Daytona observability mounts only the Agent sandbox and sets CLAUDE_CONFIG_DIR`.

Change the expected `CLAUDE_CONFIG_DIR` values from:

```ts
"/harness-observability/attempt-1/.claude"
```

to:

```ts
"/harness-observability/.claude"
```

The affected assertions should become:

```ts
assert.equal(
  mkdirCall?.env.CLAUDE_CONFIG_DIR,
  "/harness-observability/.claude",
);
assert.equal(
  claudeCall?.env.CLAUDE_CONFIG_DIR,
  "/harness-observability/.claude",
);
assert.equal(
  (observabilityStart?.[1] as { claudeConfigDir?: string }).claudeConfigDir,
  "/harness-observability/.claude",
);
assert.equal(
  (commandStart?.[1] as { claudeConfigDir?: string }).claudeConfigDir,
  "/harness-observability/.claude",
);
```

Keep this assertion unchanged:

```ts
assert.equal(
  claudeCall?.env.HARNESS_OBSERVABILITY_ATTEMPT_ROOT,
  "/harness-observability/attempt-1",
);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona observability mounts only the Agent sandbox and sets CLAUDE_CONFIG_DIR"
```

Expected: the test fails because production still injects
`/harness-observability/attempt-1/.claude`.

- [ ] **Step 3: Implement stable mounted Claude config path**

In `src/harness/observability.ts`, update `mountedClaudeObservabilityPaths()`:

```ts
export function mountedClaudeObservabilityPaths(
  config: DaytonaObservabilityConfig,
  attempt: number,
): MountedClaudeObservabilityPaths {
  if (!config.enabled) {
    throw new Error("Mounted Claude observability paths are disabled");
  }
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive safe integer");
  }
  const runRoot = config.mountPath;
  const attemptRoot = posix.join(runRoot, `attempt-${attempt}`);
  return {
    runRoot,
    attemptRoot,
    claudeConfigDir: posix.join(runRoot, ".claude"),
    manifestPath: posix.join(attemptRoot, "manifest.json"),
  };
}
```

Do not change `claudeObservabilityVolumeSubpath(runId)`. It must continue to
return `runs/<runId>` so different harness tasks remain isolated in the shared
Daytona volume.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona observability mounts only the Agent sandbox and sets CLAUDE_CONFIG_DIR"
```

Expected: the focused test passes.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/harness/observability.ts test/daytona-environment.test.ts
git commit -m "fix: keep Daytona Claude config stable per run"
```

## Task 3: Strong resume state machine in Daytona run environment

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Update imports in the test**

In `test/daytona-environment.test.ts`, update the Daytona import:

```ts
import {
  buildClaudeCommand,
  CLAUDE_COMMAND,
} from "../src/harness/sandbox/daytona.js";
```

- [ ] **Step 2: Extend the fake provider state**

In the `RecordingHandle` provider constructor type, add:

```ts
      claudeStdouts: string[];
      claudeRuns: number;
```

In `scriptedProvider(options: { ... })`, add options:

```ts
  claudeStdouts?: string[];
```

Add defaults to `state`:

```ts
    claudeStdouts: options.claudeStdouts ?? [
      JSON.stringify({ type: "result", session_id: "session-1" }),
    ],
    claudeRuns: 0,
```

- [ ] **Step 3: Make the fake agent handle Claude commands**

In `RecordingHandle.execute()`, before the fallback `return { exitCode: 0, ... }`,
add:

```ts
    if (this.role === "agent" && command.includes("/usr/local/bin/claude")) {
      this.provider.agentPrompts.push(env.HARNESS_PROMPT ?? "");
      const content = this.provider.candidateVersions[
        this.provider.agentRuns++
      ] ?? "fixed\n";
      this.files.set(
        "src/a.ts",
        workspaceFile("src/a.ts", Buffer.from(content), false),
      );
      this.provider.candidateMutations[this.provider.agentRuns - 1]?.(
        this.files,
      );
      const stdout = this.provider.claudeStdouts[
        this.provider.claudeRuns++
      ] ?? this.provider.claudeStdouts.at(-1) ?? "";
      return {
        exitCode: 0,
        stdout,
        stderr: "",
      };
    }
```

- [ ] **Step 4: Add the RED integration test for strong resume**

Add this test after `multiple attempts reuse one agent and create a fresh gate each time`:

```ts
test("Claude Daytona retries strongly resume the captured session in one agent sandbox", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-abc" }),
      JSON.stringify({ type: "result", session_id: "session-abc" }),
    ],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-resume",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(
    provider.requests.filter((request) => request.role === "agent").length,
    1,
  );
  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    2,
  );

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  const claudeCalls = agent.executeCalls.filter((call) =>
    call.command.includes("/usr/local/bin/claude")
  );
  assert.equal(claudeCalls.length, 2);
  assert.equal(claudeCalls[0]?.command, buildClaudeCommand());
  assert.equal(claudeCalls[0]?.env.HARNESS_CLAUDE_SESSION_ID, undefined);
  assert.equal(claudeCalls[1]?.command, buildClaudeCommand("session-abc"));
  assert.equal(claudeCalls[1]?.env.HARNESS_CLAUDE_SESSION_ID, "session-abc");
  assert.equal(
    claudeCalls[0]?.env.CLAUDE_CONFIG_DIR,
    "/harness-observability/.claude",
  );
  assert.equal(
    claudeCalls[1]?.env.CLAUDE_CONFIG_DIR,
    "/harness-observability/.claude",
  );

  const commandStarts = observations.filter(([event]) =>
    event === "agent.command.start"
  );
  assert.equal(
    (commandStarts[0]?.[1] as { resume?: boolean }).resume,
    false,
  );
  assert.equal(
    (commandStarts[1]?.[1] as { resume?: boolean }).resume,
    true,
  );
  assert.equal(
    (commandStarts[1]?.[1] as { claudeSessionId?: string }).claudeSessionId,
    "session-abc",
  );
});
```

- [ ] **Step 5: Add the RED fail-closed test for missing session id**

Add this test near the new strong resume test:

```ts
test("Claude Daytona fails closed when the first attempt does not report a session id", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [JSON.stringify({ type: "result" })],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-missing-session",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await assert.rejects(
    () => environment.runTask({ task: "fix it" }),
    /Claude session id/i,
  );

  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    0,
  );
  const commandEnd = observations.find(([event]) =>
    event === "agent.command.end"
  );
  assert.equal(
    (commandEnd?.[1] as { outcome?: string }).outcome,
    "error",
  );
});
```

- [ ] **Step 6: Run focused tests to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona retries strongly resume|Claude Daytona fails closed"
```

Expected: the strong resume test fails because the second Claude command still
uses the initial command or no session id env; the fail-closed test fails
because missing session id is not rejected yet.

- [ ] **Step 7: Implement strong resume in environment**

In `src/harness/sandbox/environment.ts`, update the Daytona import:

```ts
import {
  buildClaudeCommand,
  createDaytonaExecutionTarget,
  getClaudeEnvironment,
  parseClaudeSessionId,
} from "./daytona.js";
```

Remove `CLAUDE_COMMAND` from this import.

Near the existing mutable environment state:

```ts
  let agentAttempt = 0;
  let claudeSessionId: string | undefined;
```

In the Claude branch of `runTask()`, replace the fixed command execution block
with:

```ts
          const resume = claudeSessionId !== undefined;
          if (attempt > 1 && !claudeSessionId) {
            throw new Error(
              "Claude session id is missing; refusing to start a fresh retry conversation",
            );
          }
          const prompt = input.feedback
            ? `${input.task}\n\n[门禁反馈,请据此修复]\n${input.feedback}`
            : input.task;
          const command = buildClaudeCommand(claudeSessionId);
          result = await handle.execute(
            command,
            REMOTE_ROOT,
            {
              ...modelEnvironment,
              ...claudeObservationEnv,
              HARNESS_PROMPT: prompt,
              ...(claudeSessionId
                ? { HARNESS_CLAUDE_SESSION_ID: claudeSessionId }
                : {}),
            },
            AGENT_COMMAND_TIMEOUT_MS,
          );
          const capturedSessionId = parseClaudeSessionId(result.stdout);
          if (!capturedSessionId) {
            throw new Error(
              "Claude session id was not found in stream-json output",
            );
          }
          if (claudeSessionId && capturedSessionId !== claudeSessionId) {
            throw new Error(
              `Claude session id changed during resume: ${claudeSessionId} -> ${capturedSessionId}`,
            );
          }
          claudeSessionId = capturedSessionId;
          observe("agent.command.session", {
            id: handle.id,
            attempt,
            resume,
            claudeSessionId,
          });
```

Update `agent.command.start` data in the Claude branch to include resume fields:

```ts
          observe("agent.command.start", {
            id: handle.id,
            attempt,
            resume: claudeSessionId !== undefined,
            ...(claudeSessionId ? { claudeSessionId } : {}),
            ...(claudeConfigDir ? { claudeConfigDir } : {}),
          });
```

Update the successful `agent.command.end` observation to include Claude session
metadata when available:

```ts
      observe("agent.command.end", {
        id: handle.id,
        attempt,
        exitCode: result.exitCode,
        ...(options.agent.kind === "claude" && claudeSessionId
          ? { claudeSessionId, resume: attempt > 1 }
          : {}),
        durationMs: durationSince(commandStartedAt),
      });
```

Keep the existing catch block, so parser failures emit `agent.command.end` with
`outcome: "error"`.

- [ ] **Step 8: Run focused tests to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona retries strongly resume|Claude Daytona fails closed"
```

Expected: both focused tests pass.

- [ ] **Step 9: Run existing nearby Claude environment tests**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona observability|gate sandboxes use Gate runtime|Claude agent setup"
```

Expected: matching tests pass. If an existing Claude test now fails because the
fake provider has no default session id, fix `scriptedProvider()` defaults rather
than weakening strong resume.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add src/harness/sandbox/environment.ts test/daytona-environment.test.ts
git commit -m "fix: resume Daytona Claude retries by session id"
```

## Task 4: Run record session metadata

**Files:**
- Modify: `src/harness/record.ts`
- Modify: `test/observability.test.ts`

- [ ] **Step 1: Add RED assertions to run recorder tests**

In `test/observability.test.ts`, find the test that records
`agent.command.start` and `agent.command.end` for a `RunRecorder`. Add a focused
test if there is no exact one:

```ts
test("RunRecorder records Claude session and resume metadata per attempt", () => {
  const root = createGitFixture({});
  const recorder = createRunRecorder(root, {
    runId: "run-session",
    task: "fix it",
    driver: "claude",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-session",
    },
  });

  recorder.recordEvent("agent.command.start", {
    id: "agent-1",
    attempt: 1,
    claudeConfigDir: "/harness-observability/.claude",
    resume: false,
  });
  recorder.recordEvent("agent.command.end", {
    id: "agent-1",
    attempt: 1,
    exitCode: 0,
    claudeSessionId: "session-abc",
    resume: false,
  });
  recorder.recordEvent("agent.command.start", {
    id: "agent-1",
    attempt: 2,
    claudeConfigDir: "/harness-observability/.claude",
    claudeSessionId: "session-abc",
    resume: true,
  });

  const record = JSON.parse(readFileSync(recorder.path, "utf8")) as {
    attempts: Array<{
      attempt: number;
      claudeConfigDir?: string;
      claudeSessionId?: string;
      resumedFromSessionId?: string;
    }>;
  };

  assert.equal(record.attempts[0]?.claudeSessionId, "session-abc");
  assert.equal(record.attempts[1]?.resumedFromSessionId, "session-abc");
  assert.equal(
    record.attempts[1]?.claudeConfigDir,
    "/harness-observability/.claude",
  );
});
```

Use existing helpers in `test/observability.test.ts` for temporary fixture
creation and imports. If `createGitFixture` is named differently in that file,
use the existing local helper name.

- [ ] **Step 2: Run focused test to verify RED**

Run:

```bash
npm run build && node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude session"
```

Expected: the test fails because `RunRecordAttempt` does not persist
`claudeSessionId` or `resumedFromSessionId`.

- [ ] **Step 3: Extend run record attempt type**

In `src/harness/record.ts`, update `RunRecordAttempt`:

```ts
export interface RunRecordAttempt {
  attempt: number;
  claudeConfigDir?: string;
  claudeSessionId?: string;
  resumedFromSessionId?: string;
  agentSandboxId?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  gateSandboxIds: string[];
  gateOutcome?: string;
}
```

In `RunRecorder.applyEvent()`, inside the `agent.command.start` branch, add:

```ts
      if (
        value.resume === true &&
        typeof value.claudeSessionId === "string"
      ) {
        attempt.resumedFromSessionId = value.claudeSessionId;
      }
```

Inside the `agent.command.end` branch, add:

```ts
      if (typeof value.claudeSessionId === "string") {
        attempt.claudeSessionId = value.claudeSessionId;
      }
```

- [ ] **Step 4: Run focused test to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude session"
```

Expected: the focused run recorder test passes.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add src/harness/record.ts test/observability.test.ts
git commit -m "feat: record Claude resume session metadata"
```

## Task 5: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`
- Modify: `docs/architecture/daytona-langfuse-observability.md`
- Modify: `docs/daytona-local-claude-code-runbook.md`

- [ ] **Step 1: Update README**

In `README.md`, replace the paragraph:

```md
By default, the agent sandbox also mounts Daytona volume
`harness-claude-observability` at `/harness-observability`, scoped to
`runs/<runId>`. Claude Code receives:

```text
CLAUDE_CONFIG_DIR=/harness-observability/attempt-<n>/.claude
```
```

with:

````md
By default, the agent sandbox also mounts Daytona volume
`harness-claude-observability` at `/harness-observability`, scoped to
`runs/<runId>`. Claude Code receives a stable per-run config directory:

```text
CLAUDE_CONFIG_DIR=/harness-observability/.claude
```

Gate failures are fed back by resuming the captured Claude session id in the
same agent sandbox. Different harness runs remain isolated because the Daytona
volume subpath is `runs/<runId>`.
````

- [ ] **Step 2: Update runbook artifact location**

In `docs/daytona-local-claude-code-runbook.md`, replace:

```text
Claude config for attempt N: /harness-observability/attempt-N/.claude
```

with:

```text
Claude config for all attempts in this run: /harness-observability/.claude
Attempt metadata: .harness/runs/<runId>.json
```

Replace the inspection paragraph that points to
`/harness-observability/attempt-1/.claude` with:

```md
To inspect Claude artifacts for the run, browse:

```text
/harness-observability/.claude
```

The same sandbox path is reused across attempts in one run. It maps to
`runs/<runId>/.claude` in the Daytona volume, so separate harness runs do not
share Claude state.
```

- [ ] **Step 3: Update architecture docs**

In `docs/architecture/daytona-sandbox-gate.md`, replace all references to:

```text
/harness-observability/attempt-<n>/.claude
```

with:

```text
/harness-observability/.claude
```

Add this paragraph to the retry section:

```md
On the first Claude attempt, Harness captures the Claude stream-json session id.
On later attempts, gate diagnostics are sent through `claude --resume
<sessionId>` in the same agent sandbox. If Harness cannot capture or reuse the
session id, it fails closed instead of starting a fresh retry conversation.
```

In `docs/architecture/daytona-langfuse-observability.md`, update the artifact
section so it states:

```md
`CLAUDE_CONFIG_DIR` is stable for the whole harness run:
`/harness-observability/.claude`. The Daytona volume mount still uses
`subpath: runs/<runId>`, so each task has isolated persisted Claude artifacts.
```

- [ ] **Step 4: Run documentation-safe focused tests**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona retries strongly resume|Claude Daytona observability mounts"
```

Expected: focused tests still pass after docs-only edits.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add README.md docs/architecture/daytona-sandbox-gate.md docs/architecture/daytona-langfuse-observability.md docs/daytona-local-claude-code-runbook.md
git commit -m "docs: describe Daytona Claude strong resume"
```

## Task 6: Final verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js dist/test/daytona-environment.test.js dist/test/observability.test.js
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full local check**

Run:

```bash
npm run check
```

Expected: build succeeds and all unit tests pass.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: only the files listed in this plan changed.

- [ ] **Step 4: Summarize implementation**

Report:

```text
Implemented Daytona Claude strong resume in worktree:
<absolute worktree path>

Key behavior:
- one agent sandbox across retries;
- fresh gate sandbox per gate attempt;
- stable per-run CLAUDE_CONFIG_DIR;
- captured session id is required;
- retry attempts use claude --resume;
- different runs stay isolated by Daytona volume subpath runs/<runId>.

Verification:
- <commands run>
```

## Self-review

- Spec coverage: strong resume, fail-closed missing session id, per-run `.claude`
  isolation, gate sandbox isolation, and run manifest metadata are each mapped to
  tasks.
- Placeholder scan: no `TBD`, `TODO`, or "implement later" placeholders remain.
- Type consistency: command helpers are introduced in Task 1 and consumed by
  Task 3; run record fields are introduced and tested in Task 4.
- Scope check: this plan does not change candidate collection, publisher,
  command-agent behavior, or gate sandbox lifecycle.

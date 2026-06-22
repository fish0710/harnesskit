# Claude Command Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit and persist a small liveness signal while `harness run --driver claude` is waiting for the remote Claude Code command.

**Architecture:** Add a host-side heartbeat helper that wraps an async command promise and emits `agent.command.heartbeat` on a timer until the promise settles. Wire that helper around the existing Daytona Claude command path, fold heartbeat events into RunStore attempt metadata, and update `harness-prep` guidance so supervisors treat quiet Claude periods with a continuing heartbeat as active work.

**Tech Stack:** TypeScript ESM, Node timers, `node:test`, current Daytona fake sandbox tests, Markdown plugin reference docs.

---

## File Structure

- Create `src/harness/command-heartbeat.ts`: focused helper for timer lifecycle and heartbeat payload shape.
- Create `test/command-heartbeat.test.ts`: unit tests for pending, resolved, and rejected command promises.
- Modify `src/harness/sandbox/environment.ts`: add an optional test-only heartbeat interval override and wrap only the Claude command execution path.
- Modify `test/daytona-environment.test.ts`: add an environment-level test proving heartbeat is observed before `agent.command.end`.
- Modify `src/harness/record.ts`: add `commandLastHeartbeatAt` and `commandLastHeartbeatElapsedMs` to attempt summaries and fold `agent.command.heartbeat` events.
- Modify `test/observability.test.ts`: add RunStore coverage for heartbeat folding.
- Modify `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`: document quiet Claude command supervision.
- Modify `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`: document stuck-run classification with heartbeat and manual live sandbox inspection.
- Modify `plugins/harness-prep/skills/harness-prep/references/runstore-observability.md`: document RunStore heartbeat fields.
- Modify `test/daytona-gate-snapshot.test.ts`: add static assertions for the `harness-prep` guidance.

## Task 1: Add Heartbeat Helper

**Files:**
- Create: `src/harness/command-heartbeat.ts`
- Create: `test/command-heartbeat.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `test/command-heartbeat.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runWithCommandHeartbeat,
} from "../src/harness/command-heartbeat.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("runWithCommandHeartbeat emits while command is pending and stops after completion", async () => {
  const observations: Array<{
    event: string;
    data: Record<string, unknown>;
  }> = [];
  let currentMs = 1_000;
  let resolveRun: (value: string) => void = () => undefined;
  const runPromise = new Promise<string>((resolve) => {
    resolveRun = resolve;
  });
  const done = runWithCommandHeartbeat({
    id: "agent-1",
    attempt: 1,
    kind: "claude",
    streamPath: "/harness-observability/attempt-1/claude-stream.jsonl",
    intervalMs: 5,
    nowMs: () => {
      currentMs += 30;
      return currentMs;
    },
    emit: (observation) => {
      observations.push(observation);
      if (observation.event === "agent.command.heartbeat") {
        resolveRun("complete");
      }
    },
    run: () => runPromise,
  });

  const result = await withTimeout(done, 250);
  const countAfterCompletion = observations.length;
  await delay(25);

  assert.equal(result, "complete");
  assert.equal(countAfterCompletion, 1);
  assert.equal(observations.length, countAfterCompletion);
  assert.equal(observations[0]?.event, "agent.command.heartbeat");
  assert.deepEqual(observations[0]?.data, {
    id: "agent-1",
    attempt: 1,
    kind: "claude",
    elapsedMs: 30,
    claudeStreamPath: "/harness-observability/attempt-1/claude-stream.jsonl",
  });
});

test("runWithCommandHeartbeat clears the timer when the command rejects", async () => {
  const observations: Array<{ event: string; data: unknown }> = [];
  const error = new Error("remote command failed");

  await assert.rejects(
    runWithCommandHeartbeat({
      id: "agent-1",
      attempt: 1,
      kind: "claude",
      intervalMs: 5,
      emit: (observation) => observations.push(observation),
      run: async () => {
        throw error;
      },
    }),
    /remote command failed/,
  );
  await delay(25);

  assert.deepEqual(observations, []);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm run build
node --test dist/test/command-heartbeat.test.js
```

Expected: `npm run build` fails because `src/harness/command-heartbeat.ts` does not exist.

- [ ] **Step 3: Add the minimal helper implementation**

Create `src/harness/command-heartbeat.ts`:

```ts
export const DEFAULT_COMMAND_HEARTBEAT_INTERVAL_MS = 30_000;

export interface CommandHeartbeatObservation {
  event: "agent.command.heartbeat";
  data: {
    id: string;
    attempt: number;
    kind: string;
    elapsedMs: number;
    claudeStreamPath?: string;
  };
}

export interface CommandHeartbeatOptions<T> {
  id: string;
  attempt: number;
  kind: string;
  streamPath?: string;
  intervalMs?: number;
  nowMs?: () => number;
  emit: (observation: CommandHeartbeatObservation) => void;
  run: () => Promise<T>;
}

export async function runWithCommandHeartbeat<T>(
  options: CommandHeartbeatOptions<T>,
): Promise<T> {
  const intervalMs = options.intervalMs ??
    DEFAULT_COMMAND_HEARTBEAT_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const runPromise = Promise.resolve().then(options.run);
  const timer = setInterval(() => {
    options.emit({
      event: "agent.command.heartbeat",
      data: {
        id: options.id,
        attempt: options.attempt,
        kind: options.kind,
        elapsedMs: Math.max(0, nowMs() - startedAtMs),
        ...(options.streamPath
          ? { claudeStreamPath: options.streamPath }
          : {}),
      },
    });
  }, intervalMs);
  timer.unref?.();
  try {
    return await runPromise;
  } finally {
    clearInterval(timer);
  }
}
```

- [ ] **Step 4: Run the helper test and verify it passes**

Run:

```bash
npm run build
node --test dist/test/command-heartbeat.test.js
```

Expected: both tests pass.

- [ ] **Step 5: Commit the helper**

Run:

```bash
git add src/harness/command-heartbeat.ts test/command-heartbeat.test.ts
git commit -m "feat: add Claude command heartbeat helper"
```

## Task 2: Wire Heartbeat Into Daytona Claude Command

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write the failing environment test**

In `test/daytona-environment.test.ts`, add this helper after the existing `delay` helper:

```ts
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 250,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}
```

Add this test after `Claude Daytona emits live stream progress before command end`:

```ts
test("Claude Daytona emits command heartbeat before command end", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const observations: Array<[string, unknown]> = [];
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-heartbeat" }),
    ],
    claudeRunHooks: [async () => {
      await waitUntil(() =>
        observations.some(([event]) => event === "agent.command.heartbeat")
      );
    }],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    heartbeatIntervalMs: 5,
    observability: {
      runId: "run-command-heartbeat",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });

  const heartbeatIndex = observations.findIndex(([event]) =>
    event === "agent.command.heartbeat"
  );
  const endIndex = observations.findIndex(([event]) =>
    event === "agent.command.end"
  );
  const heartbeat = observations[heartbeatIndex]?.[1] as {
    id?: string;
    attempt?: number;
    kind?: string;
    elapsedMs?: number;
    claudeStreamPath?: string;
  };

  assert.notEqual(heartbeatIndex, -1);
  assert.notEqual(endIndex, -1);
  assert.ok(heartbeatIndex < endIndex);
  assert.equal(heartbeat.id, "agent-1");
  assert.equal(heartbeat.attempt, 1);
  assert.equal(heartbeat.kind, "claude");
  assert.equal(typeof heartbeat.elapsedMs, "number");
  assert.equal(
    heartbeat.claudeStreamPath,
    "/harness-observability/attempt-1/claude-stream.jsonl",
  );
});
```

- [ ] **Step 2: Run the environment test and verify it fails**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona emits command heartbeat before command end"
```

Expected: TypeScript build fails because `heartbeatIntervalMs` is not part of `DaytonaRunEnvironmentOptions`.

- [ ] **Step 3: Add the environment integration**

In `src/harness/sandbox/environment.ts`, add the import near the existing `tailClaudeStreamDuring` import:

```ts
import { runWithCommandHeartbeat } from "../command-heartbeat.js";
```

Add this optional field to `DaytonaRunEnvironmentOptions`:

```ts
  heartbeatIntervalMs?: number;
```

Replace the current Claude command result block:

```ts
          result = streamPath
            ? await tailClaudeStreamDuring({
              id: handle.id,
              attempt,
              path: streamPath,
              read: (path) => handle.readFile(path),
              emit: ({ event, data }) => observe(event, data),
              run: runClaudeCommand,
              intervalMs: 50,
              noOutputWarningMs: 60_000,
            })
            : await runClaudeCommand();
```

with:

```ts
          const runObservedClaudeCommand = () =>
            streamPath
              ? tailClaudeStreamDuring({
                id: handle.id,
                attempt,
                path: streamPath,
                read: (path) => handle.readFile(path),
                emit: ({ event, data }) => observe(event, data),
                run: runClaudeCommand,
                intervalMs: 50,
                noOutputWarningMs: 60_000,
              })
              : runClaudeCommand();
          result = await runWithCommandHeartbeat({
            id: handle.id,
            attempt,
            kind: "claude",
            streamPath,
            intervalMs: options.heartbeatIntervalMs,
            emit: ({ event, data }) => observe(event, data),
            run: runObservedClaudeCommand,
          });
```

- [ ] **Step 4: Run the environment test and verify it passes**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona emits command heartbeat before command end"
```

Expected: the targeted environment test passes.

- [ ] **Step 5: Commit the environment integration**

Run:

```bash
git add src/harness/sandbox/environment.ts test/daytona-environment.test.ts
git commit -m "feat: emit heartbeat during Daytona Claude command"
```

## Task 3: Persist Heartbeat Metadata In RunStore

**Files:**
- Modify: `src/harness/record.ts`
- Modify: `test/observability.test.ts`

- [ ] **Step 1: Write the failing RunStore test**

In `test/observability.test.ts`, add this test after `RunRecorder records Claude stream progress on the attempt`:

```ts
test("RunRecorder records Claude command heartbeat on the attempt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-heartbeat-"));
  const timestamps = [
    "2026-06-22T09:00:00.000Z",
    "2026-06-22T09:00:00.100Z",
    "2026-06-22T09:01:30.000Z",
    "2026-06-22T09:01:30.100Z",
    "2026-06-22T09:01:30.200Z",
  ];
  const recorder = createRunRecorder(
    cwd,
    {
      runId: "run-heartbeat",
      createdAt: "2026-06-22T09:00:00.000Z",
      task: "show Claude command liveness",
      driver: "daytona(claude)",
      observability: {
        enabled: true,
        backend: "daytona-volume",
        volumeName: "harness-claude-observability",
        mountPath: "/harness-observability",
        runRoot: "/harness-observability/runs/run-heartbeat",
      },
    },
    () => timestamps.shift() ?? "2026-06-22T09:01:30.300Z",
  );

  recorder.recordEvent("agent.command.heartbeat", {
    attempt: 1,
    id: "agent-1",
    kind: "claude",
    elapsedMs: 90_000,
    claudeStreamPath: "/harness-observability/attempt-1/claude-stream.jsonl",
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.attempts[0].agentSandboxId, "agent-1");
  assert.equal(
    parsed.attempts[0].commandLastHeartbeatAt,
    "2026-06-22T09:01:30.000Z",
  );
  assert.equal(parsed.attempts[0].commandLastHeartbeatElapsedMs, 90_000);
  assert.equal(
    parsed.attempts[0].claudeStreamPath,
    "/harness-observability/attempt-1/claude-stream.jsonl",
  );
});
```

- [ ] **Step 2: Run the RunStore test and verify it fails**

Run:

```bash
npm run build
node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude command heartbeat on the attempt"
```

Expected: the targeted test fails because heartbeat events are not folded into attempts.

- [ ] **Step 3: Add heartbeat fields and event folding**

In `src/harness/record.ts`, add these fields to `RunRecordAttempt` after `claudeLastActivityAt?: string;`:

```ts
  commandLastHeartbeatAt?: string;
  commandLastHeartbeatElapsedMs?: number;
```

In `isRunRecordAttempt`, add these checks after `isOptionalString(value.claudeStreamPath) &&`:

```ts
    (
      value.commandLastHeartbeatAt === undefined ||
      (
        typeof value.commandLastHeartbeatAt === "string" &&
        isValidTimestamp(value.commandLastHeartbeatAt)
      )
    ) &&
    (
      value.commandLastHeartbeatElapsedMs === undefined ||
      isNonNegativeSafeInteger(value.commandLastHeartbeatElapsedMs)
    ) &&
```

In `applyEvent`, include the heartbeat event in the allowed event list:

```ts
      event !== "agent.command.heartbeat" &&
```

Add this block after the existing `if (event === "agent.command.progress") { ... }` block:

```ts
    if (event === "agent.command.heartbeat") {
      if (typeof value.id === "string") attempt.agentSandboxId = value.id;
      if (typeof value.claudeStreamPath === "string") {
        attempt.claudeStreamPath = value.claudeStreamPath;
      }
      if (typeof value.elapsedMs === "number") {
        attempt.commandLastHeartbeatElapsedMs = value.elapsedMs;
      }
      attempt.commandLastHeartbeatAt = this.now();
    }
```

- [ ] **Step 4: Run the RunStore test and verify it passes**

Run:

```bash
npm run build
node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude command heartbeat on the attempt"
```

Expected: the targeted RunStore test passes.

- [ ] **Step 5: Commit the RunStore update**

Run:

```bash
git add src/harness/record.ts test/observability.test.ts
git commit -m "feat: persist Claude command heartbeat metadata"
```

## Task 4: Update Harness Prep Guidance

**Files:**
- Modify: `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/runstore-observability.md`
- Modify: `test/daytona-gate-snapshot.test.ts`

- [ ] **Step 1: Write the failing documentation assertions**

In `test/daytona-gate-snapshot.test.ts`, add this test after `harness-prep snapshot guidance documents legacy nvm boundaries`:

```ts
test("harness-prep documents Claude command heartbeat supervision", () => {
  const runSupervision = readFileSync(
    "plugins/harness-prep/skills/harness-prep/references/run-supervision.md",
    "utf8",
  );
  const blockerAnalysis = readFileSync(
    "plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md",
    "utf8",
  );
  const runstore = readFileSync(
    "plugins/harness-prep/skills/harness-prep/references/runstore-observability.md",
    "utf8",
  );

  assert.match(runSupervision, /agent\.command\.heartbeat/);
  assert.match(runSupervision, /no Claude command output can be normal/i);
  assert.match(runSupervision, /heartbeat.*active/i);
  assert.match(blockerAnalysis, /heartbeat stops unexpectedly/i);
  assert.match(blockerAnalysis, /\/home\/daytona\/\.claude/);
  assert.match(blockerAnalysis, /projects\//);
  assert.match(runstore, /commandLastHeartbeatAt/);
  assert.match(runstore, /commandLastHeartbeatElapsedMs/);
});
```

- [ ] **Step 2: Run the documentation test and verify it fails**

Run:

```bash
npm run build
node --test dist/test/daytona-gate-snapshot.test.js --test-name-pattern "harness-prep documents Claude command heartbeat supervision"
```

Expected: the targeted documentation test fails because the references do not document heartbeat semantics yet.

- [ ] **Step 3: Update run supervision guidance**

In `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`, add this section after the RunStore extraction paragraph in `Progress Updates`:

```md
### Claude Command Quiet Periods

For `--driver claude`, the phase from `agent.command.start` to
`agent.command.end` can be quiet. During that period, no Claude command output
can be normal and the `claude-stream.jsonl` file may stay empty until the
command exits.

Use `agent.command.heartbeat` as the liveness signal:

- If heartbeat events continue, the Agent command is active. Do not call the
  sandbox stuck only because stdout, terminal output, or stream bytes are quiet.
- If the heartbeat stops unexpectedly, the CLI exits, the command times out, or
  RunStore records `status: "error"`, switch to `blocker-analysis.md`.
- If the wait is long but heartbeat continues, say that Harness is still waiting
  on the remote Claude command and keep polling the run record.
```

- [ ] **Step 4: Update blocker analysis guidance**

In `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`, add this paragraph after the event extraction command:

```md
If the latest Agent event is `agent.command.heartbeat` and there is no later
`agent.command.end`, classify the run as active unless the heartbeat stops
unexpectedly, the CLI process exits, the command timeout fires, or RunStore
records an error. A quiet Claude command is not by itself evidence of a stuck
sandbox.
```

In the `Daytona .claude Inspection` section, add this paragraph after `If Agent behavior is unclear, inspect persisted Claude artifacts through observability-and-review.md.`:

```md
While the Agent sandbox is still alive and heartbeat continues, the recorded
`attempts[].claudeConfigDir` usually points at `/home/daytona/.claude`. An
operator may attach to the Agent sandbox and inspect `projects/` under that
directory to understand current Claude Code activity. Treat this as manual
diagnosis only; do not parse Claude Code private files as the automated
liveness signal.
```

- [ ] **Step 5: Update RunStore observability guidance**

In `plugins/harness-prep/skills/harness-prep/references/runstore-observability.md`, add these bullets under the existing Claude artifact correlation field list:

```md
- `attempts[].commandLastHeartbeatAt` -> host timestamp of the latest
  `agent.command.heartbeat` folded into the attempt.
- `attempts[].commandLastHeartbeatElapsedMs` -> elapsed time reported by the
  latest heartbeat while Harness was waiting on the Agent command.
```

- [ ] **Step 6: Run the documentation test and verify it passes**

Run:

```bash
npm run build
node --test dist/test/daytona-gate-snapshot.test.js --test-name-pattern "harness-prep documents Claude command heartbeat supervision"
```

Expected: the targeted documentation test passes.

- [ ] **Step 7: Commit the skill guidance update**

Run:

```bash
git add plugins/harness-prep/skills/harness-prep/references/run-supervision.md plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md plugins/harness-prep/skills/harness-prep/references/runstore-observability.md test/daytona-gate-snapshot.test.ts
git commit -m "docs: document Claude command heartbeat supervision"
```

## Task 5: Full Verification And Archive

**Files:**
- Read: `docs/superpowers/specs/2026-06-22-claude-command-heartbeat-design.md`
- Verify: all modified source, tests, and plugin docs

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm run build
node --test dist/test/command-heartbeat.test.js
node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona emits command heartbeat before command end"
node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude command heartbeat on the attempt"
node --test dist/test/daytona-gate-snapshot.test.js --test-name-pattern "harness-prep documents Claude command heartbeat supervision"
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full check**

Run:

```bash
npm run check
```

Expected: build succeeds and all Node test files pass.

- [ ] **Step 3: Inspect the final diff against the spec**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Expected changed files include the helper, Daytona integration, RunStore, tests, spec, plan, and `harness-prep` reference docs. No Gate preflight or publication files should be modified by this feature.

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review` after focused and full verification pass. Ask the reviewer to check:

```text
Review the Claude command heartbeat feature in this worktree. Focus on timer lifecycle, no heartbeat after command settlement, RunStore event folding, and whether harness-prep docs correctly prevent supervisors from treating quiet Claude output as a stuck sandbox.
```

- [ ] **Step 5: Address review findings**

If review finds defects, apply the same pattern as earlier tasks:

```bash
npm run build
npm run check
git add <changed-files>
git commit -m "<specific fix message>"
```

Expected: review defects are resolved with tests that fail before the fix and pass after the fix.

- [ ] **Step 6: Archive the work**

After review is clean and `npm run check` passes, use `superpowers:finishing-a-development-branch` to choose the integration path. If merging locally into `main`, run:

```bash
git status --short
git switch main
git merge --no-ff claude-realtime-stream
npm run check
```

Expected: `main` contains the heartbeat feature and full verification passes after merge.

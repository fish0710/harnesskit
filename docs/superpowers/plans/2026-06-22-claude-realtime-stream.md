# Claude Realtime Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit Claude text/tool/progress observations from live Daytona PTY output while preserving raw stream-json artifacts.

**Architecture:** Keep the existing JSONL parser in `src/harness/claude-stream.ts`, add a live-output runner around it, and route observability-enabled Claude commands through `SandboxHandle.runPty` with an output callback. Keep file tailing as a fallback/helper, but do not depend on remote file reads for real-time Claude activity.

**Tech Stack:** TypeScript, Node test runner, Daytona SDK sandbox abstraction, existing Harness RunStore observation pipeline.

---

### Task 1: Live Stream Helper

**Files:**
- Modify: `src/harness/claude-stream.ts`
- Modify: `test/claude-stream.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add two tests to `test/claude-stream.test.ts`:

```ts
test("observeClaudeStreamDuring emits progress before command resolves", async () => {
  const observations: ClaudeStreamObservation[] = [];
  let resolveRun: (value: string) => void = () => undefined;
  const runReleased = new Promise<string>((resolve) => {
    resolveRun = resolve;
  });
  let progressSeenBeforeResolve = false;

  const resultPromise = observeClaudeStreamDuring({
    id: "agent-1",
    attempt: 1,
    path: "/harness-observability/attempt-1/claude-stream.jsonl",
    noOutputWarningMs: 60_000,
    now: () => "2026-06-22T08:00:00.000Z",
    emit: (event) => {
      observations.push(event);
      if (event.event === "agent.command.progress") {
        progressSeenBeforeResolve = true;
      }
    },
    run: async (onOutput) => {
      onOutput(Buffer.from(`${assistantLine()}\n`));
      assert.equal(progressSeenBeforeResolve, true);
      return await runReleased;
    },
  });

  resolveRun("agent done");
  assert.equal(await resultPromise, "agent done");
  assert.ok(observations.some((event) => event.event === "agent.claude.tool"));
  assert.equal(progressSeenBeforeResolve, true);
});

test("observeClaudeStreamDuring warns while PTY produces no output", async () => {
  const observations: ClaudeStreamObservation[] = [];
  let resolveRun: (value: string) => void = () => undefined;
  const runReleased = new Promise<string>((resolve) => {
    resolveRun = resolve;
  });

  const resultPromise = observeClaudeStreamDuring({
    id: "agent-1",
    attempt: 1,
    path: "/harness-observability/attempt-1/claude-stream.jsonl",
    intervalMs: 5,
    noOutputWarningMs: 10,
    now: () => "2026-06-22T08:00:00.000Z",
    emit: (event) => {
      observations.push(event);
      if (event.event === "agent.command.no-output-warning") {
        resolveRun("agent done");
      }
    },
    run: () => runReleased,
  });

  assert.equal(await resultPromise, "agent done");
  assert.ok(observations.some((event) =>
    event.event === "agent.command.no-output-warning" &&
    event.data.bytes === 0
  ));
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm run build && node --test dist/test/claude-stream.test.js
```

Expected: build fails because `observeClaudeStreamDuring` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/harness/claude-stream.ts`, export:

```ts
export type ClaudeLiveOutput = string | Buffer | Uint8Array;

export interface ObserveClaudeStreamOptions<T> extends ClaudeStreamMeta {
  emit(observation: ClaudeStreamObservation): void;
  run(onOutput: (chunk: ClaudeLiveOutput) => void): Promise<T>;
  intervalMs?: number;
  noOutputWarningMs?: number;
}

export async function observeClaudeStreamDuring<T>(
  options: ObserveClaudeStreamOptions<T>,
): Promise<T> {
  const state = createClaudeStreamState();
  const intervalMs = options.intervalMs ?? 1000;
  const noOutputWarningMs = options.noOutputWarningMs ?? 60_000;
  let lastOutputMs = Date.now();
  let lastWarningMs = 0;

  const timer = setInterval(() => {
    const nowMs = Date.now();
    const idleMs = nowMs - lastOutputMs;
    if (
      idleMs >= noOutputWarningMs &&
      nowMs - lastWarningMs >= noOutputWarningMs
    ) {
      lastWarningMs = nowMs;
      options.emit({
        event: "agent.command.no-output-warning",
        data: {
          id: options.id,
          attempt: options.attempt,
          path: options.path,
          bytes: state.offset,
          idleMs,
        },
      });
    }
  }, intervalMs);
  timer.unref();

  try {
    return await options.run((chunk) => {
      lastOutputMs = Date.now();
      const text = typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
      consumeClaudeStreamChunk(text, state, options.emit, options);
    });
  } finally {
    clearInterval(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/claude-stream.test.js
```

Expected: `claude-stream.test.js` passes.

### Task 2: PTY Output Callback

**Files:**
- Modify: `src/harness/sandbox/types.ts`
- Modify: `src/harness/sandbox/daytona.ts`
- Modify: fake handles in `test/daytona-environment.test.ts`, `test/daytona-sandbox.test.ts`, and `test/preflight-runtime.test.ts`
- Modify: `test/daytona-sandbox.test.ts`

- [ ] **Step 1: Write the failing PTY callback test**

Add to `test/daytona-sandbox.test.ts`:

```ts
test("SDK handle forwards PTY chunks to the output observer", async () => {
  const sandbox = fakeSdkSandbox();
  const handle = createSandboxHandleForTest(sandbox);
  const chunks: string[] = [];

  const result = await handle.runPty(
    "printf 'one\\n'; printf 'two\\n'",
    "/workspace/candidate",
    {},
    30_000,
    undefined,
    (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")),
  );

  assert.equal(result.exitCode, 0);
  assert.ok(chunks.join("").includes("one"));
  assert.ok(chunks.join("").includes("two"));
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js --test-name-pattern "forwards PTY chunks"
```

Expected: TypeScript build fails because `runPty` does not accept an output observer.

- [ ] **Step 3: Extend the interface and implementation**

Change `SandboxHandle.runPty` to:

```ts
runPty(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs?: number,
  signal?: AbortSignal,
  onOutput?: (chunk: Buffer) => void | Promise<void>,
): Promise<SandboxCommandResult>;
```

In `DaytonaSandboxHandle.runPty`, inside `onData(data)`, after `chunks.push(chunk)` and before the output-size check returns, call:

```ts
await onOutput?.(chunk);
```

Update fake handles to accept the optional argument and call it when they simulate PTY output.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js --test-name-pattern "forwards PTY chunks"
```

Expected: targeted test passes.

### Task 3: Claude Command Uses Tee

**Files:**
- Modify: `src/harness/sandbox/daytona.ts`
- Modify: `test/daytona-config.test.ts` or the existing test file that covers `buildClaudeCommand`

- [ ] **Step 1: Write the failing command construction test**

Update the existing command test to assert:

```ts
assert.match(CLAUDE_COMMAND, /tee "\$HARNESS_CLAUDE_STREAM_PATH"/);
assert.match(CLAUDE_COMMAND, /PIPESTATUS\[0\]/);
assert.doesNotMatch(CLAUDE_COMMAND, /> "\$HARNESS_CLAUDE_STREAM_PATH"; status=\$\?/);
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-config.test.js --test-name-pattern "writes stream-json"
```

Expected: assertion fails because the command still uses direct redirection.

- [ ] **Step 3: Replace redirection with tee**

Change `streamPersistingClaudeCommand` to create the stream directory, run Claude through `tee`, and preserve Claude's pipeline status with bash `PIPESTATUS[0]`.

- [ ] **Step 4: Run test to verify GREEN**

Run the same targeted test. Expected: pass.

### Task 4: Route Observability-Enabled Claude Through PTY Live Parser

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write the failing environment test**

Update `Claude Daytona emits live stream progress before command end` so fake `runPty` emits a stream chunk while the command promise is held pending. Assert the first `agent.command.progress` appears before `agent.command.end` and that `agent.claude.tool` appears before command end.

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona emits live stream progress"
```

Expected: fails because environment still calls `handle.execute` plus file tail.

- [ ] **Step 3: Switch observability-enabled Claude execution**

In `createDaytonaRunEnvironment`, when `HARNESS_CLAUDE_STREAM_PATH` is present, call `observeClaudeStreamDuring` and pass a `run` function that invokes:

```ts
handle.runPty(
  command,
  REMOTE_ROOT,
  commandEnv,
  AGENT_COMMAND_TIMEOUT_MS,
  undefined,
  (chunk) => onOutput(chunk),
)
```

When there is no stream path, keep `handle.execute`.

- [ ] **Step 4: Run test to verify GREEN**

Run the same targeted environment test. Expected: pass.

### Task 5: RunStore and Full Verification

**Files:**
- Verify: `src/harness/record.ts`
- Verify: `test/observability.test.ts`

- [ ] **Step 1: Run targeted suite**

Run:

```bash
npm run build && node --test dist/test/claude-stream.test.js dist/test/daytona-sandbox.test.js dist/test/daytona-environment.test.js dist/test/observability.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full check**

Run:

```bash
npm run check
```

Expected: all tests pass.

- [ ] **Step 3: Inspect diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only planned files changed.

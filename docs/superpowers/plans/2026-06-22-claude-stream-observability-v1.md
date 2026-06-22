# Claude Stream Observability V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live Claude Code progress for Daytona runs by tailing `claude-stream.jsonl` while the command is running and persisting progress metadata in RunStore.

**Architecture:** Keep Claude Code on the existing `executeCommand` path and add a side-channel tailer over the already-mounted observability stream file. The tailer parses new JSONL by offset, emits safe progress events through `onObservation`, and the existing CLI/RunStore event path records and displays those events.

**Tech Stack:** TypeScript ESM, Node.js `node:test`, Daytona SDK-backed sandbox abstractions, existing Harness RunStore and observation callbacks.

---

## Spec

This plan implements:

```text
docs/superpowers/specs/2026-06-22-claude-stream-observability-v1-design.md
```

The implementation must not proceed past RED tests until that spec and this
plan are present in the working tree.

## File Structure

- Create `src/harness/claude-stream.ts`
  - Owns stream-json line parsing, event summarization, offset tracking, and optional polling around an async command.
  - Has no Daytona SDK dependency.

- Modify `src/harness/sandbox/types.ts`
  - Add a small `readFile(path)` method to `SandboxHandle` so the tailer can read the mounted stream file.

- Modify `src/harness/sandbox/daytona.ts`
  - Implement `readFile(path)` using `sandbox.fs.downloadFile`.

- Modify `src/harness/sandbox/environment.ts`
  - Start the tailer before `handle.execute(CLAUDE_COMMAND, ...)`.
  - Drain the stream after command completion or command error.
  - Emit progress, tool, text, result, heartbeat, and warning observations with sanitized summaries.

- Modify `src/harness/record.ts`
  - Teach attempts to persist `claudeStreamBytes`, `claudeLastEventType`, `claudeLastTool`, and `claudeLastActivityAt` from progress events.

- Modify `test/daytona-environment.test.ts`
  - Cover that Claude runs emit progress while the command is still running and drain the final result.

- Create `test/claude-stream.test.ts`
  - Cover stream parsing, offset behavior, partial-line behavior, tool/text/result summaries, and heartbeats.

- Modify `test/observability.test.ts`
  - Cover RunStore attempt metadata from `agent.command.progress`.

## Task 1: Stream Parser And Polling Tailer

**Files:**
- Create: `src/harness/claude-stream.ts`
- Create: `test/claude-stream.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `test/claude-stream.test.ts` with tests that call `consumeClaudeStreamChunk()` on:

```ts
[
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Reading files and checking package metadata." },
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "npm view @dcloudio/uni-app version" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    duration_ms: 478635,
    duration_api_ms: 439449,
    ttft_ms: 57728,
    num_turns: 16,
    session_id: "session-1",
  }),
].join("\n") + "\n"
```

Expected events:

- `agent.command.progress` with increasing `bytes`, `lastEventType`, and `lastActivityAt`.
- `agent.claude.text` with a short text summary.
- `agent.claude.tool` with `tool: "Bash"` and command summary.
- `agent.claude.result` with duration, API duration, TTFT, turns, and session id.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npm run build && node --test dist/test/claude-stream.test.js
```

Expected: build fails because `src/harness/claude-stream.ts` does not exist.

- [ ] **Step 3: Implement parser and tailer helpers**

Create `src/harness/claude-stream.ts` with:

- `ClaudeStreamState` containing `offset`, `pending`, `lastActivityAt`, and `lastEventType`.
- `consumeClaudeStreamChunk(input, state, emit, meta)` that parses complete new lines only and keeps a partial trailing line in `pending`.
- `tailClaudeStreamDuring({ read, path, emit, run, intervalMs, noOutputWarningMs })` that polls while `run()` is pending, emits progress on growth, warns after no output, and final-drains after `run()` resolves or rejects.

## Task 2: Wire Tailer Into Daytona Claude Execution

**Files:**
- Modify: `src/harness/sandbox/types.ts`
- Modify: `src/harness/sandbox/daytona.ts`
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing integration test**

Add a test in `test/daytona-environment.test.ts` where the fake `RecordingHandle.execute()` for Claude waits on a deferred promise, writes stream content into `HARNESS_CLAUDE_STREAM_PATH` before resolving, and asserts that `agent.command.progress` is observed before `agent.command.end`.

- [ ] **Step 2: Run targeted test and verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js --test-name-pattern "Claude Daytona emits live stream progress"
```

Expected: no progress events are emitted before command end.

- [ ] **Step 3: Add `SandboxHandle.readFile()` and implement it**

Extend `SandboxHandle` with:

```ts
readFile(path: string): Promise<Buffer>;
```

Implement in `DaytonaSandboxHandle` with `this.sandbox.fs.downloadFile(daytonaSdkPath(path))`.

- [ ] **Step 4: Start the tailer around Claude command execution**

In `createDaytonaRunEnvironment()`, replace the direct `result = await handle.execute(...)` call for Claude with `tailClaudeStreamDuring({ read: (path) => handle.readFile(path), path: HARNESS_CLAUDE_STREAM_PATH, emit: observe, run: () => handle.execute(...) })` when observability stream path is available. Keep direct `handle.execute(...)` when observability is disabled.

## Task 3: Persist Progress In RunStore

**Files:**
- Modify: `src/harness/record.ts`
- Modify: `test/observability.test.ts`

- [ ] **Step 1: Write failing RunStore metadata test**

Add a test that records:

```ts
recorder.recordEvent("agent.command.progress", {
  attempt: 1,
  path: "/harness-observability/attempt-1/claude-stream.jsonl",
  bytes: 128,
  lastEventType: "assistant",
  lastTool: "Bash",
  lastActivityAt: "2026-06-22T08:00:00.000Z",
});
```

Expected attempt fields:

- `claudeStreamBytes: 128`
- `claudeLastEventType: "assistant"`
- `claudeLastTool: "Bash"`
- `claudeLastActivityAt: "2026-06-22T08:00:00.000Z"`

- [ ] **Step 2: Run targeted test and verify RED**

Run:

```bash
npm run build && node --test dist/test/observability.test.js --test-name-pattern "RunRecorder records Claude stream progress"
```

Expected: fields are missing.

- [ ] **Step 3: Persist progress event fields**

Update `RunRecorder.applyEvent()` to include `agent.command.progress` in the allowed events and copy the four fields onto the current attempt.

## Task 4: Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm run build && node --test dist/test/claude-stream.test.js dist/test/daytona-environment.test.js dist/test/observability.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full check**

Run:

```bash
npm run check
```

Expected: TypeScript build and full test suite pass.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

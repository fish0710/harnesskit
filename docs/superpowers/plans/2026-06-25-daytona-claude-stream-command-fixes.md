# Daytona Claude Stream Command Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Daytona Claude stream wrapper so observability mode runs Claude exactly once, does not add a 30 second delay after success, and treats Claude result events consistently with the existing session parser.

**Architecture:** Keep the fix localized to the command generator in `src/harness/sandbox/daytona.ts` and its existing tests in `test/daytona-claude-resume.test.ts`. The shell wrapper should preserve the current behavior of streaming stdout through `tee`, persisting stderr for diagnostics, and allowing a short post-result grace period only when Claude remains alive after a successful result event.

**Tech Stack:** TypeScript, Node.js built-in test runner, generated POSIX/bash command strings for Daytona execution.

---

## File Structure

- Modify `src/harness/sandbox/daytona.ts`
  - Add small helpers for shell-safe inline JavaScript and JSON-based Claude result checks.
  - Change the observability branch to exit from the outer shell after the inner bash wrapper finishes.
  - Stop waiting for the watchdog after Claude exits normally.
  - Keep parsing session ids with `parseClaudeSessionId` and avoid broad refactors.
- Modify `test/daytona-claude-resume.test.ts`
  - Assert the observability branch exits before the fallback `exec`.
  - Assert the command contains watchdog cleanup.
  - Assert result detection accepts result JSON without `is_error` and rejects explicit `is_error: true`.
- Optionally run `npm run build` and the focused compiled test after building.

---

### Task 1: Prevent Double Claude Execution In Observability Mode

**Files:**
- Modify: `src/harness/sandbox/daytona.ts:43-82`
- Test: `test/daytona-claude-resume.test.ts:31-51`

- [ ] **Step 1: Write the failing test**

In `test/daytona-claude-resume.test.ts`, update the stream persistence test to require the outer shell to exit after the inner bash wrapper:

```ts
test("buildClaudeCommand persists stream-json to the mounted observability path when configured", () => {
  const command = buildClaudeCommand();

  assert.match(command, /\$\{HARNESS_CLAUDE_STREAM_PATH:-\}/);
  assert.match(command, /\/usr\/bin\/bash -lc/);
  assert.match(command, /\/usr\/bin\/bash -lc .*; wrapper_status=\$\?; exit "\$wrapper_status"; fi; exec/s);
  assert.match(command, /mkdir -p "\$\(dirname "\$HARNESS_CLAUDE_STREAM_PATH"\)"/);
  assert.doesNotMatch(command, /> "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.match(command, /mkfifo "\$claude_stdout_pipe"/);
  assert.match(command, /tee -a "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.match(command, /HARNESS_CLAUDE_RESULT_GRACE_SECONDS:-30/);
  assert.match(command, /kill "\$claude_pid"/);
  assert.match(command, /claude_stderr_path="\/tmp\/harness-claude-stderr-\$\{HARNESS_ATTEMPT:-0\}\.log"/);
  assert.match(command, /2> "\$claude_stderr_path"/);
  assert.doesNotMatch(command, /\bstatus=\$\?/);
  assert.match(command, /claude_status=\$\?/);
  assert.match(command, /cat "\$claude_stderr_path"/);
  assert.match(command, /exit "\$claude_status"/);
  assert.match(command, /exec "\/usr\/local\/bin\/claude"/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: FAIL because the generated command currently has `/usr/bin/bash -lc ...; fi; exec ...` and does not contain `wrapper_status=$?; exit "$wrapper_status"`.

- [ ] **Step 3: Implement the outer-shell exit**

In `src/harness/sandbox/daytona.ts`, change the return value in `streamPersistingClaudeCommand` to preserve the inner wrapper status and exit the outer shell before the fallback `exec`:

```ts
  return 'if [ -n "${HARNESS_CLAUDE_STREAM_PATH:-}" ]; then ' +
    `/usr/bin/bash -lc ${shellSingleQuote(streamScript)}; ` +
    'wrapper_status=$?; exit "$wrapper_status"; ' +
    "fi; " +
    `exec ${invoke}`;
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/sandbox/daytona.ts test/daytona-claude-resume.test.ts
git commit -m "fix: exit after Daytona Claude stream wrapper"
```

---

### Task 2: Avoid Waiting For The Grace Watchdog After Normal Exit

**Files:**
- Modify: `src/harness/sandbox/daytona.ts:43-75`
- Test: `test/daytona-claude-resume.test.ts:31-51`

- [ ] **Step 1: Write the failing test**

In the same stream persistence test in `test/daytona-claude-resume.test.ts`, add assertions for watchdog cancellation and non-blocking cleanup:

```ts
  assert.match(command, /kill "\$result_killer_pid" 2>\/dev\/null \|\| true/);
  assert.match(command, /wait "\$result_killer_pid" 2>\/dev\/null \|\| true/);
```

Keep these assertions near the existing `HARNESS_CLAUDE_RESULT_GRACE_SECONDS:-30` and `kill "$claude_pid"` assertions so the test documents one behavior block.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: FAIL because the command waits for `result_killer_pid` but never cancels it.

- [ ] **Step 3: Implement watchdog cancellation after Claude exits**

In `src/harness/sandbox/daytona.ts`, replace the existing watchdog wait line:

```ts
    'if [ -n "$result_killer_pid" ]; then wait "$result_killer_pid" 2>/dev/null || true; fi',
```

with:

```ts
    'if [ -n "$result_killer_pid" ]; then ' +
      'kill "$result_killer_pid" 2>/dev/null || true; ' +
      'wait "$result_killer_pid" 2>/dev/null || true; ' +
      "fi",
```

This keeps zombie cleanup but avoids sleeping for the full grace period when the Claude process already exited.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/sandbox/daytona.ts test/daytona-claude-resume.test.ts
git commit -m "fix: cancel Claude result watchdog after exit"
```

---

### Task 3: Parse Result Events Instead Of Text-Matching `is_error`

**Files:**
- Modify: `src/harness/sandbox/daytona.ts:39-75`
- Test: `test/daytona-claude-resume.test.ts`

- [ ] **Step 1: Add command-level tests for result event semantics**

Add these tests to `test/daytona-claude-resume.test.ts` after the stream persistence test:

```ts
test("buildClaudeCommand treats result events without is_error as successful", () => {
  const command = buildClaudeCommand();

  assert.match(command, /result_success=\$\(printf "%s\\n" "\$claude_line" \| \/usr\/local\/bin\/node -e/);
  assert.match(command, /process\.exit\(record\.type === "result" && record\.is_error !== true \? 0 : 1\)/);
  assert.doesNotMatch(command, /\*"is_error":false\*/);
});

test("buildClaudeCommand still detects result events before starting the grace watchdog", () => {
  const command = buildClaudeCommand();

  assert.match(command, /if printf "%s\\n" "\$claude_line" \| \/usr\/local\/bin\/node -e/);
  assert.match(command, /process\.exit\(record\.type === "result" \? 0 : 1\)/);
  assert.match(command, /result_seen=1/);
  assert.match(command, /result_success="\$result_event_success"/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: FAIL because the command currently uses bash substring checks for `"type":"result"` and `"is_error":false`.

- [ ] **Step 3: Add a helper for inline Node JSON checks**

In `src/harness/sandbox/daytona.ts`, add this helper below `shellSingleQuote`:

```ts
function nodeJsonPredicate(script: string): string {
  return `/usr/local/bin/node -e ${shellSingleQuote(script)}`;
}
```

- [ ] **Step 4: Replace brittle result text matching**

In `streamPersistingClaudeCommand`, before `const streamScript = [...]`, add:

```ts
  const isResultEvent = nodeJsonPredicate(
    'let input = ""; ' +
      'process.stdin.setEncoding("utf8"); ' +
      'process.stdin.on("data", chunk => input += chunk); ' +
      'process.stdin.on("end", () => { ' +
      'try { const record = JSON.parse(input); ' +
      'process.exit(record && typeof record === "object" && record.type === "result" ? 0 : 1); ' +
      '} catch { process.exit(1); } ' +
      "});",
  );
  const isSuccessfulResultEvent = nodeJsonPredicate(
    'let input = ""; ' +
      'process.stdin.setEncoding("utf8"); ' +
      'process.stdin.on("data", chunk => input += chunk); ' +
      'process.stdin.on("end", () => { ' +
      'try { const record = JSON.parse(input); ' +
      'process.exit(record && typeof record === "object" && record.type === "result" && record.is_error !== true ? 0 : 1); ' +
      '} catch { process.exit(1); } ' +
      "});",
  );
```

Then replace the `while` body entries:

```ts
    'while IFS= read -r claude_line; do ' +
      'printf "%s\\n" "$claude_line" | tee -a "$HARNESS_CLAUDE_STREAM_PATH"; ' +
      'if printf "%s\\n" "$claude_line" | ' + isResultEvent + "; then " +
        "result_seen=1; " +
        'result_event_success=0; ' +
        'if printf "%s\\n" "$claude_line" | ' + isSuccessfulResultEvent + "; then " +
          'result_event_success=1; ' +
        "fi; " +
        'result_success="$result_event_success"; ' +
        'if [ -z "$result_killer_pid" ] && [ "$result_event_success" -eq 1 ]; then ' +
          '( sleep "${HARNESS_CLAUDE_RESULT_GRACE_SECONDS:-30}"; ' +
          'if kill -0 "$claude_pid" 2>/dev/null; then kill "$claude_pid" 2>/dev/null || true; fi ) & ' +
          "result_killer_pid=$!; " +
        "fi; " +
      "fi; " +
    'done < "$claude_stdout_pipe"',
```

This uses JSON semantics instead of whitespace-sensitive text matching and only starts the grace watchdog for successful result events.

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```bash
npm run build && node --test dist/test/daytona-claude-resume.test.js
```

Expected: PASS.

- [ ] **Step 6: Run Daytona environment tests that cover stream/session behavior**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js dist/test/daytona-sandbox.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/harness/sandbox/daytona.ts test/daytona-claude-resume.test.ts
git commit -m "fix: parse Claude result events in stream wrapper"
```

---

### Task 4: Full Verification

**Files:**
- No new source edits expected.

- [ ] **Step 1: Run the full project check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git diff HEAD~3..HEAD -- src/harness/sandbox/daytona.ts test/daytona-claude-resume.test.ts
```

Expected:
- `streamPersistingClaudeCommand` exits the outer shell after the stream wrapper.
- The watchdog process is killed and waited after Claude exits.
- Result detection is JSON-based and accepts `is_error` being absent.
- Existing session-id parsing remains unchanged except for the already-present persisted stream fallback.

- [ ] **Step 3: Commit verification notes if this repo tracks plan updates**

If the implementation updates this plan with checkmarks, commit it with the code:

```bash
git add docs/superpowers/plans/2026-06-25-daytona-claude-stream-command-fixes.md
git commit -m "docs: add Daytona Claude stream fix plan"
```

---

## Self-Review

- Spec coverage: The plan covers all three review findings: double execution, extra grace wait, and brittle result success detection.
- Placeholder scan: No task relies on unspecified validation or future work.
- Type consistency: All referenced functions and tests are in `src/harness/sandbox/daytona.ts` and `test/daytona-claude-resume.test.ts`; no new public API is introduced.

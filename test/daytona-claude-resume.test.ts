import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  buildClaudeCommand,
  CLAUDE_COMMAND,
  parseClaudeSessionIdFromCommandOutput,
  parseClaudeSessionId,
} from "../src/harness/sandbox/daytona.js";

const RESUME_COMMAND =
  '"/usr/local/bin/claude" --dangerously-skip-permissions ' +
  '--resume "$HARNESS_CLAUDE_SESSION_ID" ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';

function writeFakeClaude(dir: string, script: string): string {
  const fakeClaudePath = join(dir, "claude");
  writeFileSync(fakeClaudePath, `#!/bin/sh\n${script}\n`);
  chmodSync(fakeClaudePath, 0o755);
  return fakeClaudePath;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function localClaudeCommand(fakeClaudePath: string): string {
  return buildClaudeCommand()
    .replaceAll("/usr/bin/bash -lc", "/bin/bash -lc")
    .replaceAll("/usr/local/bin/node", shellSingleQuote(process.execPath))
    .replaceAll('"/usr/local/bin/claude"', shellSingleQuote(fakeClaudePath));
}

function executeLocalClaudeCommand(
  fakeClaudePath: string,
  streamPath: string,
  options: {
    timeoutMs?: number;
    graceSeconds?: string;
    terminateGraceSeconds?: string;
  } = {},
) {
  const command = localClaudeCommand(fakeClaudePath);
  const attempt = `test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stderrPath = `/tmp/harness-claude-stderr-${attempt}.log`;
  const start = performance.now();
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: {
      ...process.env,
      HARNESS_CLAUDE_STREAM_PATH: streamPath,
      HARNESS_PROMPT: "fix it",
      HARNESS_CLAUDE_RESULT_GRACE_SECONDS: options.graceSeconds ?? "0.1",
      HARNESS_CLAUDE_TERMINATE_GRACE_SECONDS:
        options.terminateGraceSeconds ?? "0.1",
      HARNESS_ATTEMPT: attempt,
    },
    timeout: options.timeoutMs ?? 3000,
    encoding: "utf8",
  });
  rmSync(stderrPath, { force: true });
  return { elapsedMs: performance.now() - start, result };
}

test("buildClaudeCommand returns the initial command without a session id and equals CLAUDE_COMMAND", () => {
  assert.equal(buildClaudeCommand(), CLAUDE_COMMAND);
  assert.match(CLAUDE_COMMAND, /exec "\/usr\/local\/bin\/claude"/);
  assert.doesNotMatch(CLAUDE_COMMAND, /--resume/);
});

test("buildClaudeCommand resumes through an env-provided session id", () => {
  assert.match(buildClaudeCommand("session-safe-123"), /--resume "\$HARNESS_CLAUDE_SESSION_ID"/);
  assert.match(buildClaudeCommand("session-safe-123"), new RegExp(RESUME_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(
    buildClaudeCommand("session-safe-123"),
    /session-safe-123/,
  );
});

test("buildClaudeCommand persists stream-json to the mounted observability path when configured", () => {
  const command = buildClaudeCommand();

  assert.match(command, /\$\{HARNESS_CLAUDE_STREAM_PATH:-\}/);
  assert.match(command, /\/usr\/bin\/bash -lc/);
  assert.match(command, /\/usr\/bin\/bash -lc .*; wrapper_status=\$\?; exit "\$wrapper_status"; fi; exec/s);
  assert.match(command, /set -e; mkdir -p/);
  assert.match(command, /mkfifo "\$claude_stdout_pipe"; set \+e/);
  assert.match(command, /mkdir -p "\$\(dirname "\$HARNESS_CLAUDE_STREAM_PATH"\)"/);
  assert.doesNotMatch(command, /> "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.doesNotMatch(command, /mktemp -u/);
  assert.match(command, /claude_tmp_dir="\$\(mktemp -d \/tmp\/harness-claude-\$\{HARNESS_ATTEMPT:-0\}\.XXXXXX\)"/);
  assert.match(command, /claude_stderr_path="\$claude_tmp_dir\/stderr\.log"/);
  assert.doesNotMatch(command, /claude_stderr_path="\/tmp\/harness-claude-stderr-\$\{HARNESS_ATTEMPT:-0\}\.log"/);
  assert.match(command, /claude_stdout_pipe="\$claude_tmp_dir\/stdout\.fifo"/);
  assert.match(command, /claude_reader_status_path="\$claude_tmp_dir\/reader\.status"/);
  assert.match(command, /claude_reader_diagnostic_path="\$claude_tmp_dir\/reader\.diagnostic"/);
  assert.match(command, /claude_term_marker_path="\$claude_tmp_dir\/claude\.term"/);
  assert.match(command, /claude_kill_marker_path="\$claude_tmp_dir\/claude\.kill"/);
  assert.match(command, /cleanup_tmp\(\) \{ rm -rf "\$claude_tmp_dir"; \}/);
  assert.match(command, /trap cleanup_tmp EXIT/);
  assert.match(command, /mkfifo "\$claude_stdout_pipe"/);
  assert.match(command, /HARNESS_CLAUDE_PID="\$claude_pid"/);
  assert.match(command, /HARNESS_CLAUDE_STDOUT_PIPE="\$claude_stdout_pipe"/);
  assert.match(command, /HARNESS_CLAUDE_READER_STATUS_PATH="\$claude_reader_status_path"/);
  assert.match(command, /HARNESS_CLAUDE_READER_DIAGNOSTIC_PATH="\$claude_reader_diagnostic_path"/);
  assert.match(command, /HARNESS_CLAUDE_TERM_MARKER_PATH="\$claude_term_marker_path"/);
  assert.match(command, /\/usr\/local\/bin\/node -e /);
  assert.ok(
    command.indexOf("HARNESS_CLAUDE_STDOUT_PIPE") <
      command.indexOf("HARNESS_CLAUDE_STREAM_PATH, \"a\""),
    "reader must open the FIFO before the fallible stream path",
  );
  assert.doesNotMatch(command, /< "\$claude_stdout_pipe"/);
  assert.doesNotMatch(command, /tee -a "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.match(command, /HARNESS_CLAUDE_RESULT_GRACE_SECONDS \?\? "30"/);
  assert.match(command, /function scheduleGraceTimer\(\)/);
  assert.match(command, /if \(finalResultSuccess\) scheduleGraceTimer\(\)/);
  assert.match(command, /fs\.writeFileSync\(process\.env\.HARNESS_CLAUDE_READER_DIAGNOSTIC_PATH, diagnostic\)/);
  assert.match(command, /function fail\(error\)/);
  assert.match(command, /catch \(error\) \{\n      fail\(error\);/);
  assert.match(command, /process\.kill\(Number\(process\.env\.HARNESS_CLAUDE_PID\), "SIGTERM"\)/);
  assert.match(command, /fs\.writeFileSync\(process\.env\.HARNESS_CLAUDE_TERM_MARKER_PATH, ""\)/);
  assert.ok(
    command.indexOf('process.kill(Number(process.env.HARNESS_CLAUDE_PID), "SIGTERM")') <
      command.indexOf('fs.writeFileSync(process.env.HARNESS_CLAUDE_TERM_MARKER_PATH, "")'),
    "reader should only mark Claude as wrapper-terminated after sending SIGTERM",
  );
  assert.match(command, /2> "\$claude_stderr_path"/);
  assert.doesNotMatch(command, /\bstatus=\$\?/);
  assert.match(command, /reader_status="\$\(cat "\$claude_reader_status_path"\)"/);
  assert.match(command, /terminate_claude\(\) \{/);
  assert.match(command, /terminate_reader\(\) \{/);
  assert.match(command, /HARNESS_CLAUDE_TERMINATE_GRACE_SECONDS:-1/);
  assert.match(command, /if kill "\$claude_pid" 2>\/dev\/null; then touch "\$claude_term_marker_path"; fi/);
  assert.match(command, /kill -KILL "\$claude_pid"/);
  assert.match(command, /if kill -KILL "\$claude_pid" 2>\/dev\/null; then touch "\$claude_kill_marker_path"; fi/);
  assert.match(command, /kill -KILL "\$reader_pid"/);
  assert.match(command, /& reader_pid=\$!/);
  assert.match(command, /while \[ ! -s "\$claude_reader_status_path" \]; do if ! kill -0 "\$reader_pid" 2>\/dev\/null; then break; fi; sleep 0\.05; done/);
  assert.match(command, /if \[ -s "\$claude_reader_status_path" \]; then reader_status="\$\(cat "\$claude_reader_status_path"\)"; else reader_status=1; fi/);
  assert.match(command, /case "\$reader_status" in 0\|1\) ;;\s+\*\) reader_status=1 ;;\s+esac/);
  assert.match(command, /if \[ "\$reader_status" -ne 0 \] && \[ -s "\$claude_reader_diagnostic_path" \]; then cat "\$claude_reader_diagnostic_path"; fi/);
  assert.match(command, /killed_for_reader_failure=1; terminate_claude/);
  assert.match(command, /if \[ "\$reader_status" -eq 0 \] && kill -0 "\$claude_pid" 2>\/dev\/null; then terminate_claude; fi/);
  assert.match(command, /claude_status=\$\?/);
  assert.match(command, /if \[ "\$claude_status" -eq 137 \]; then wait "\$claude_killer_pid" 2>\/dev\/null \|\| true/);
  assert.match(command, /if \[ "\$killed_for_reader_failure" -eq 1 \]; then exit "\$reader_status"; fi/);
  assert.match(command, /\[ "\$claude_status" -eq 143 \] && \[ -e "\$claude_term_marker_path" \]/);
  assert.match(command, /\[ "\$claude_status" -eq 137 \] && \[ -e "\$claude_kill_marker_path" \]/);
  assert.match(command, /if \[ "\$reader_status" -ne 0 \] && \[ "\$claude_status" -eq 0 \]; then exit "\$reader_status"; fi/);
  assert.match(command, /cat "\$claude_stderr_path"/);
  assert.match(command, /exit "\$claude_status"/);
  assert.match(command, /exec "\/usr\/local\/bin\/claude"/);
});

test("buildClaudeCommand treats result events without is_error as successful", () => {
  const command = buildClaudeCommand();

  assert.match(command, /\/usr\/local\/bin\/node -e/);
  assert.match(command, /if \(record\.type !== "result"\) return/);
  assert.match(command, /finalResultSuccess = record\.is_error !== true/);
  assert.doesNotMatch(command, /"is_error":false/);
});

test("buildClaudeCommand only starts the grace watchdog for successful result events", () => {
  const command = buildClaudeCommand();
  const nodeInvocations = command.match(/\/usr\/local\/bin\/node -e/g) ?? [];

  assert.equal(nodeInvocations.length, 1);
  assert.doesNotMatch(command, /if printf "%s\\n" "\$claude_line" \| \/usr\/local\/bin\/node -e/);
  assert.doesNotMatch(command, /result_seen/);
  assert.match(command, /finalResultSuccess = record\.is_error !== true/);
  assert.match(command, /if \(finalResultSuccess\) scheduleGraceTimer\(\); else clearGraceTimer\(\)/);
});

test("buildClaudeCommand generates valid background process syntax", () => {
  const command = buildClaudeCommand();

  assert.doesNotMatch(command, /&;/);
  assert.match(command, /& claude_pid=\$!/);
});

test("buildClaudeCommand lets the persistent reader own grace watchdog cancellation", () => {
  const command = buildClaudeCommand();

  assert.doesNotMatch(command, /result_sleep_pid/);
  assert.doesNotMatch(command, /result_killer_pid/);
  assert.match(command, /let graceTimer/);
  assert.match(command, /clearTimeout\(graceTimer\)/);
  assert.match(command, /process\.kill\(Number\(process\.env\.HARNESS_CLAUDE_PID\), "SIGTERM"\)/);
  assert.doesNotMatch(command, /&;/);

  const readerIndex = command.indexOf('reader_status="$(cat "$claude_reader_status_path")"');
  const statusIndex = command.indexOf("claude_status=$?");
  assert.notEqual(readerIndex, -1);
  assert.notEqual(statusIndex, -1);
  assert.ok(readerIndex < statusIndex, "reader status must be captured before Claude status");
});

test("buildClaudeCommand handles high-volume stream output without per-line Node processes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-volume-"));
  try {
    const highVolumeClaudePath = writeFakeClaude(
      tempDir,
      [
        "i=0",
        'while [ "$i" -lt 400 ]; do',
        `  printf '%s\\n' ${shellSingleQuote('{"type":"assistant","delta":"chunk"}')}`,
        "  i=$((i + 1))",
        "done",
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "volume-session" }')}`,
        "exec sleep 10",
      ].join("\n"),
    );
    const highVolume = executeLocalClaudeCommand(
      highVolumeClaudePath,
      join(tempDir, "high-volume-stream.jsonl"),
      { timeoutMs: 3000 },
    );

    assert.equal(highVolume.result.error, undefined);
    assert.equal(highVolume.result.status, 0, highVolume.result.stderr);
    assert.ok(
      highVolume.elapsedMs < 2500,
      `expected high-volume stream to finish quickly, elapsed ${highVolume.elapsedMs}ms`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand bounds termination when Claude ignores TERM after success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-ignore-term-"));
  try {
    const ignoreTermClaudePath = writeFakeClaude(
      tempDir,
      [
        "trap '' TERM",
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "ignore-term-session" }')}`,
        "exec sleep 10",
      ].join("\n"),
    );
    const ignoreTerm = executeLocalClaudeCommand(
      ignoreTermClaudePath,
      join(tempDir, "ignore-term-stream.jsonl"),
      {
        timeoutMs: 2500,
        graceSeconds: "0.1",
        terminateGraceSeconds: "0.1",
      },
    );

    assert.equal(ignoreTerm.result.error, undefined);
    assert.equal(ignoreTerm.result.status, 0, ignoreTerm.result.stderr);
    assert.ok(
      ignoreTerm.elapsedMs < 2300,
      `expected ignored TERM success to be bounded, elapsed ${ignoreTerm.elapsedMs}ms`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand resets success grace on later stream activity before a final error", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-grace-reset-"));
  try {
    const graceResetClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "grace-reset-success" }')}`,
        "i=0",
        'while [ "$i" -lt 5 ]; do',
        "  sleep 0.06",
        `  printf '%s\\n' ${shellSingleQuote('{ "type": "assistant", "delta": "heartbeat" }')}`,
        "  i=$((i + 1))",
        "done",
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "is_error": true, "session_id": "grace-reset-error" }')}`,
        "sleep 1",
        "exit 42",
      ].join("\n"),
    );
    const graceReset = executeLocalClaudeCommand(
      graceResetClaudePath,
      join(tempDir, "grace-reset-stream.jsonl"),
      {
        timeoutMs: 5000,
        graceSeconds: "0.15",
      },
    );

    assert.equal(graceReset.result.error, undefined);
    assert.equal(graceReset.result.status, 42, graceReset.result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand does not convert external SIGKILL after success into success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-external-kill-"));
  try {
    const externalKillClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "external-kill-session" }')}`,
        'kill -KILL "$$"',
      ].join("\n"),
    );
    const externalKill = executeLocalClaudeCommand(
      externalKillClaudePath,
      join(tempDir, "external-kill-stream.jsonl"),
      {
        timeoutMs: 2500,
        graceSeconds: "5",
      },
    );

    assert.equal(externalKill.result.error, undefined);
    assert.notEqual(externalKill.result.status, 0, externalKill.result.stderr);
    assert.equal(externalKill.result.status, 137, externalKill.result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand does not convert external SIGTERM after success into success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-external-term-"));
  try {
    const externalTermClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "external-term-session" }')}`,
        'kill -TERM "$$"',
      ].join("\n"),
    );
    const externalTerm = executeLocalClaudeCommand(
      externalTermClaudePath,
      join(tempDir, "external-term-stream.jsonl"),
      {
        timeoutMs: 2500,
        graceSeconds: "5",
      },
    );

    assert.equal(externalTerm.result.error, undefined);
    assert.notEqual(externalTerm.result.status, 0, externalTerm.result.stderr);
    assert.equal(externalTerm.result.status, 143, externalTerm.result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand reports stream write failures from the reader line handler", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-write-failure-"));
  const streamPipe = join(tempDir, "stream.fifo");
  const mkfifo = spawnSync("mkfifo", [streamPipe], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  const streamReader = spawn(
    "/bin/sh",
    ["-c", `exec 3<${shellSingleQuote(streamPipe)}`],
    { stdio: "ignore" },
  );

  try {
    const writeFailureClaudePath = writeFakeClaude(
      tempDir,
      [
        "sleep 0.1",
        `printf '%s\\n' ${shellSingleQuote('{ "type": "assistant", "delta": "first line" }')}`,
        "exit 0",
      ].join("\n"),
    );
    const writeFailure = executeLocalClaudeCommand(
      writeFailureClaudePath,
      streamPipe,
      { timeoutMs: 3000 },
    );

    assert.equal(writeFailure.result.error, undefined);
    assert.equal(writeFailure.result.status, 1, writeFailure.result.stderr);
    assert.match(writeFailure.result.stdout, /\[claude stream reader\]/);
  } finally {
    streamReader.kill();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand fails fast when the stream path cannot be opened", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-invalid-stream-"));
  try {
    const invalidStreamPath = join(tempDir, "stream-path-is-directory");
    mkdirSync(invalidStreamPath);
    const fakeClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "invalid-stream-session" }')}`,
        "exit 0",
      ].join("\n"),
    );
    const invalidStream = executeLocalClaudeCommand(
      fakeClaudePath,
      invalidStreamPath,
      { timeoutMs: 1500 },
    );

    assert.equal(invalidStream.result.error, undefined);
    assert.equal(invalidStream.result.status, 1, invalidStream.result.stderr);
    assert.match(invalidStream.result.stdout, /\[claude stream reader\]/);
    assert.ok(
      invalidStream.elapsedMs < 1400,
      `expected invalid stream path to fail fast, elapsed ${invalidStream.elapsedMs}ms`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand is executable locally and preserves Claude completion status", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harness-claude-command-"));
  try {
    const successClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "success-session" }')}`,
        "exec sleep 10",
      ].join("\n"),
    );
    const success = executeLocalClaudeCommand(
      successClaudePath,
      join(tempDir, "success-stream.jsonl"),
    );
    const successStream = readFileSync(
      join(tempDir, "success-stream.jsonl"),
      "utf8",
    );

    assert.equal(success.result.error, undefined);
    assert.equal(success.result.status, 0, success.result.stderr);
    assert.equal(success.result.stdout, successStream);
    assert.ok(
      success.elapsedMs < 2500,
      `expected success to exit before grace period, elapsed ${success.elapsedMs}ms`,
    );

    const failureClaudePath = writeFakeClaude(
      tempDir,
      'printf \'%s\\n\' \'{"type":"result","is_error":false,"session_id":"failure-session"}\'\nexit 42',
    );
    const failure = executeLocalClaudeCommand(
      failureClaudePath,
      join(tempDir, "failure-stream.jsonl"),
    );

    assert.equal(failure.result.error, undefined);
    assert.equal(failure.result.status, 42, failure.result.stderr);

    const explicitErrorClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "is_error": true, "session_id": "error-session" }')}`,
        "sleep 1",
        "exit 42",
      ].join("\n"),
    );
    const explicitError = executeLocalClaudeCommand(
      explicitErrorClaudePath,
      join(tempDir, "explicit-error-stream.jsonl"),
      { timeoutMs: 6000 },
    );

    assert.equal(explicitError.result.error, undefined);
    assert.equal(explicitError.result.status, 42, explicitError.result.stderr);

    const explicitErrorZeroClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "is_error": true, "session_id": "error-zero-session" }')}`,
        "exit 0",
      ].join("\n"),
    );
    const explicitErrorZero = executeLocalClaudeCommand(
      explicitErrorZeroClaudePath,
      join(tempDir, "explicit-error-zero-stream.jsonl"),
    );

    assert.equal(explicitErrorZero.result.error, undefined);
    assert.equal(explicitErrorZero.result.status, 1, explicitErrorZero.result.stderr);

    const successThenErrorClaudePath = writeFakeClaude(
      tempDir,
      [
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "session_id": "first-success-session" }')}`,
        `printf '%s\\n' ${shellSingleQuote('{ "type": "result", "is_error": true, "session_id": "final-error-session" }')}`,
        "sleep 1",
        "exit 42",
      ].join("\n"),
    );
    const successThenError = executeLocalClaudeCommand(
      successThenErrorClaudePath,
      join(tempDir, "success-then-error-stream.jsonl"),
      { timeoutMs: 6000 },
    );

    assert.equal(successThenError.result.error, undefined);
    assert.equal(successThenError.result.status, 42, successThenError.result.stderr);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildClaudeCommand rejects unsafe session ids before command selection", () => {
  for (const sessionId of [
    "",
    " session-safe-123",
    "session-safe-123 ",
    "session\nsafe",
    "session\tsafe",
    "session\u0000safe",
    "session\u007fsafe",
  ]) {
    assert.throws(
      () => buildClaudeCommand(sessionId),
      /unsafe Claude session id/i,
    );
  }
});

test("parseClaudeSessionId extracts the first safe stream-json session id from session_id or sessionId", () => {
  assert.equal(
    parseClaudeSessionId(
      [
        JSON.stringify({ type: "system" }),
        JSON.stringify({ session_id: "first-safe-session" }),
        JSON.stringify({ sessionId: "second-safe-session" }),
      ].join("\n"),
    ),
    "first-safe-session",
  );

  assert.equal(
    parseClaudeSessionId(JSON.stringify({ sessionId: "camel-safe-session" })),
    "camel-safe-session",
  );
});

test("parseClaudeSessionId ignores non-json lines and unsafe session ids", () => {
  assert.equal(
    parseClaudeSessionId(
      [
        "Claude starting",
        "{not json",
        JSON.stringify({ session_id: "" }),
        JSON.stringify({ session_id: " trim-changes" }),
        JSON.stringify({ sessionId: "control\nchar" }),
        JSON.stringify({ session_id: "safe-after-unsafe" }),
      ].join("\n"),
    ),
    "safe-after-unsafe",
  );
});

test("parseClaudeSessionIdFromCommandOutput falls back to persisted stream content", () => {
  assert.equal(
    parseClaudeSessionIdFromCommandOutput({
      stdout: "Daytona command returned without the stream",
      stream: [
        JSON.stringify({ type: "system", session_id: "stream-session" }),
        JSON.stringify({ type: "result", subtype: "success", session_id: "stream-session" }),
      ].join("\n"),
    }),
    "stream-session",
  );
});

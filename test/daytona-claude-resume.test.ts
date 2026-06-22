import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildClaudeCommand,
  CLAUDE_COMMAND,
  parseClaudeSessionId,
} from "../src/harness/sandbox/daytona.js";

const RESUME_COMMAND =
  '"/usr/local/bin/claude" --dangerously-skip-permissions ' +
  '--resume "$HARNESS_CLAUDE_SESSION_ID" ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';

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

test("buildClaudeCommand writes stream-json directly to the mounted observability path when configured", () => {
  const command = buildClaudeCommand();

  assert.match(command, /\$\{HARNESS_CLAUDE_STREAM_PATH:-\}/);
  assert.match(command, /mkdir -p "\$\(dirname "\$HARNESS_CLAUDE_STREAM_PATH"\)"/);
  assert.match(command, /> "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.match(command, /status=\$\?/);
  assert.match(command, /cat "\$HARNESS_CLAUDE_STREAM_PATH"/);
  assert.match(command, /exit "\$status"/);
  assert.match(command, /exec "\/usr\/local\/bin\/claude"/);
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

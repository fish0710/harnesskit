import assert from "node:assert/strict";
import { test } from "node:test";

import {
  redactObservationData,
  renderSandboxObservation,
} from "../src/cli.js";

test("CLI observation redaction masks nested secret-like keys before JSON output", () => {
  const circular: Record<string, unknown> = { keep: "visible" };
  circular.self = circular;

  const redacted = redactObservationData({
    id: "sandbox-1",
    nested: {
      apiKey: "daytona-key",
      token: "model-token",
      authorization: "Bearer secret",
      auth: { password: "pw", ok: true },
    },
    array: [
      { cookie: "session=value" },
      { api_key: "snake-key" },
      "plain",
    ],
    circular,
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("daytona-key"), false);
  assert.equal(serialized.includes("model-token"), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(serialized.includes("session=value"), false);
  assert.equal(serialized.includes("snake-key"), false);
  assert.match(serialized, /"apiKey":"\[redacted\]"/);
  assert.match(serialized, /"token":"\[redacted\]"/);
  assert.match(serialized, /"authorization":"\[redacted\]"/);
  assert.match(serialized, /"cookie":"\[redacted\]"/);
  assert.match(serialized, /"self":"\[circular\]"/);
  assert.match(serialized, /"id":"sandbox-1"/);
});

test("CLI renders Claude stream observations as live summaries", () => {
  assert.equal(
    renderSandboxObservation("agent.claude.text", {
      text: "I found the failing gate and will update src/app.ts.",
    }),
    "    · Claude: I found the failing gate and will update src/app.ts.",
  );
  assert.equal(
    renderSandboxObservation("agent.claude.tool", {
      tool: "Bash",
      command: "npm test",
    }),
    '    · Claude tool: Bash command="npm test"',
  );
  assert.equal(
    renderSandboxObservation("agent.command.progress", {
      bytes: 128,
      lastEventType: "assistant",
      lastTool: "Bash",
    }),
    "    · Claude progress: assistant via Bash · 128 bytes parsed",
  );
  assert.equal(
    renderSandboxObservation("agent.claude.result", {
      sessionId: "session-live",
      turns: 3,
      durationMs: 1200,
    }),
    "    · Claude result: session=session-live · turns=3 · durationMs=1200",
  );
});

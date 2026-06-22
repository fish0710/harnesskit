import assert from "node:assert/strict";
import { test } from "node:test";

import {
  consumeClaudeStreamChunk,
  createClaudeStreamState,
  tailClaudeStreamDuring,
  type ClaudeStreamObservation,
} from "../src/harness/claude-stream.js";

function assistantLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "Reading files and checking package metadata.",
        },
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: "npm view @dcloudio/uni-app version",
          },
        },
      ],
    },
  });
}

function resultLine(): string {
  return JSON.stringify({
    type: "result",
    duration_ms: 478635,
    duration_api_ms: 439449,
    ttft_ms: 57728,
    num_turns: 16,
    session_id: "session-1",
  });
}

test("consumeClaudeStreamChunk emits progress, text, tool, and result observations", () => {
  const state = createClaudeStreamState();
  const observations: ClaudeStreamObservation[] = [];

  consumeClaudeStreamChunk(
    `${assistantLine()}\n${resultLine()}\n`,
    state,
    (event) => observations.push(event),
    {
      id: "agent-1",
      attempt: 1,
      path: "/harness-observability/attempt-1/claude-stream.jsonl",
      now: () => "2026-06-22T08:00:00.000Z",
    },
  );

  assert.deepEqual(
    observations.map((observation) => observation.event),
    [
      "agent.claude.text",
      "agent.claude.tool",
      "agent.command.progress",
      "agent.command.progress",
      "agent.claude.result",
    ],
  );
  assert.deepEqual(observations[0]?.data, {
    id: "agent-1",
    attempt: 1,
    text: "Reading files and checking package metadata.",
  });
  assert.deepEqual(observations[1]?.data, {
    id: "agent-1",
    attempt: 1,
    tool: "Bash",
    command: "npm view @dcloudio/uni-app version",
  });
  assert.deepEqual(observations[2]?.data, {
    id: "agent-1",
    attempt: 1,
    path: "/harness-observability/attempt-1/claude-stream.jsonl",
    bytes: Buffer.byteLength(`${assistantLine()}\n`),
    lastEventType: "assistant",
    lastTool: "Bash",
    lastActivityAt: "2026-06-22T08:00:00.000Z",
  });
  assert.deepEqual(observations[4]?.data, {
    id: "agent-1",
    attempt: 1,
    sessionId: "session-1",
    durationMs: 478635,
    durationApiMs: 439449,
    ttftMs: 57728,
    turns: 16,
  });
  assert.equal(state.offset, Buffer.byteLength(`${assistantLine()}\n${resultLine()}\n`));
  assert.equal(state.pending, "");
});

test("consumeClaudeStreamChunk keeps partial trailing lines until complete", () => {
  const state = createClaudeStreamState();
  const observations: ClaudeStreamObservation[] = [];
  const line = assistantLine();

  consumeClaudeStreamChunk(
    line.slice(0, 12),
    state,
    (event) => observations.push(event),
    {
      id: "agent-1",
      attempt: 1,
      path: "/harness-observability/attempt-1/claude-stream.jsonl",
      now: () => "2026-06-22T08:00:00.000Z",
    },
  );

  assert.equal(observations.length, 0);
  assert.equal(state.offset, 0);
  assert.equal(state.pending, line.slice(0, 12));

  consumeClaudeStreamChunk(
    `${line.slice(12)}\n`,
    state,
    (event) => observations.push(event),
    {
      id: "agent-1",
      attempt: 1,
      path: "/harness-observability/attempt-1/claude-stream.jsonl",
      now: () => "2026-06-22T08:00:01.000Z",
    },
  );

  assert.equal(
    observations.filter((observation) =>
      observation.event === "agent.command.progress"
    ).length,
    1,
  );
  assert.equal(state.offset, Buffer.byteLength(`${line}\n`));
  assert.equal(state.pending, "");
});

test("tailClaudeStreamDuring polls while command is running and drains final output", async () => {
  const observations: ClaudeStreamObservation[] = [];
  const snapshots = [
    Buffer.from(""),
    Buffer.from(`${assistantLine()}\n`),
    Buffer.from(`${assistantLine()}\n${resultLine()}\n`),
  ];
  let readCount = 0;
  let resolveRun: (value: string) => void = () => undefined;
  const runPromise = new Promise<string>((resolve) => {
    resolveRun = resolve;
  });

  const tailPromise = tailClaudeStreamDuring({
    id: "agent-1",
    attempt: 1,
    path: "/harness-observability/attempt-1/claude-stream.jsonl",
    intervalMs: 5,
    noOutputWarningMs: 60_000,
    now: () => "2026-06-22T08:00:00.000Z",
    emit: (event) => observations.push(event),
    read: async () => {
      const snapshot = snapshots[Math.min(readCount, snapshots.length - 1)]!;
      readCount++;
      if (readCount === 3) resolveRun("agent done");
      return snapshot;
    },
    run: () => runPromise,
  });

  const result = await tailPromise;

  assert.equal(result, "agent done");
  assert.ok(readCount >= 3);
  assert.ok(
    observations.some((observation) =>
      observation.event === "agent.claude.tool" &&
      (observation.data as { tool?: string }).tool === "Bash"
    ),
  );
  assert.ok(
    observations.some((observation) =>
      observation.event === "agent.claude.result" &&
      (observation.data as { sessionId?: string }).sessionId === "session-1"
    ),
  );
});

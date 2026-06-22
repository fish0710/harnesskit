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

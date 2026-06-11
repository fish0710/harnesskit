import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClaudeQueryOptions, claudeDriver } from "../src/harness/drivers.js";
import type { ClaudeSdkModule, StartLangfuseOptions } from "../src/harness/langfuse.js";

test("claude driver 默认允许 Bash/Edit/Write 且不询问权限", () => {
  const options = buildClaudeQueryOptions();

  assert.deepEqual(options.allowedTools, ["Bash", "Edit", "Write"]);
  assert.equal(options.permissionMode, "dontAsk");
});

test("claude driver hooks 使用 SDK matcher 数组并上报事件", async () => {
  const observations: Array<[string, unknown]> = [];
  const options = buildClaudeQueryOptions({
    onObservation: (event, data) => observations.push([event, data]),
  });

  for (const event of ["PreToolUse", "PostToolUse", "Stop"] as const) {
    const matchers = options.hooks[event];
    assert.ok(Array.isArray(matchers), `${event} 应为 matcher 数组`);
    assert.ok(Array.isArray(matchers[0]?.hooks), `${event} matcher 应包含 hooks 数组`);
    const input = { hook_event_name: event };
    const result = await matchers[0]!.hooks[0]!(input, undefined, {
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, {});
    assert.deepEqual(observations.at(-1), [event, input]);
  }
});

test("claude driver 多轮复用同一个 Langfuse 生命周期并在 close 时关闭", async () => {
  let queryCalls = 0;
  let starts = 0;
  let shutdowns = 0;
  const originalSdk: ClaudeSdkModule = { query: () => emptyMessages() };
  const tracedSdk: ClaudeSdkModule = {
    query: () => {
      queryCalls++;
      return twoMessages();
    },
  };
  const driver = claudeDriver({
    dependencies: {
      loadClaudeSdk: async () => originalSdk,
      startObservability: async (options: StartLangfuseOptions) => {
        starts++;
        assert.equal(options.claudeSdk, originalSdk);
        return {
          enabled: true,
          claudeSdk: tracedSdk,
          async shutdown() { shutdowns++; },
        };
      },
    },
  });

  const first = await driver.runTask({ task: "test", cwd: "." });
  const second = await driver.runTask({ task: "test again", cwd: "." });

  assert.equal(queryCalls, 2);
  assert.equal(starts, 1);
  assert.equal(shutdowns, 0);
  assert.match(first.summary, /2 条消息/);
  assert.match(second.summary, /2 条消息/);

  await driver.close?.();
  await driver.close?.();
  assert.equal(shutdowns, 1);
});

test("claude driver 在 query 抛错后可由 close 关闭 Langfuse", async () => {
  let shutdowns = 0;
  const driver = claudeDriver({
    dependencies: {
      loadClaudeSdk: async () => ({ query: () => emptyMessages() }),
      startObservability: async () => ({
        enabled: true,
        claudeSdk: {
          query: () => ({
            async *[Symbol.asyncIterator]() {
              throw new Error("query failed");
            },
          }),
        },
        async shutdown() { shutdowns++; },
      }),
    },
  });

  await assert.rejects(
    () => driver.runTask({ task: "test", cwd: "." }),
    /query failed/,
  );
  assert.equal(shutdowns, 0);
  await driver.close?.();
  assert.equal(shutdowns, 1);
});

function emptyMessages(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

function twoMessages(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "assistant" };
      yield { type: "result" };
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_AGENT_INSTRUMENTATION_SCOPE,
  startLangfuseObservability,
  type LangfuseDependencies,
} from "../src/harness/langfuse.js";

function emptyQuery(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      // No messages needed for lifecycle tests.
    },
  };
}

test("langfuse: 缺少任一密钥时不加载观测依赖", async () => {
  let loads = 0;
  const claudeSdk = { query: emptyQuery };

  const observability = await startLangfuseObservability({
    claudeSdk,
    env: { LANGFUSE_PUBLIC_KEY: "pk-only" },
    loadDependencies: async () => {
      loads++;
      throw new Error("不应加载");
    },
  });

  assert.equal(observability.enabled, false);
  assert.equal(observability.claudeSdk, claudeSdk);
  assert.equal(loads, 0);
  await observability.shutdown();
});

test("langfuse: 配置完整时包装 query、扩展 span 过滤并幂等关闭", async () => {
  let started = 0;
  let shutdowns = 0;
  let defaultFilterInput: unknown;
  let filter: ((input: { otelSpan: { instrumentationScope: { name: string } } }) => boolean) | undefined;
  const originalQuery = emptyQuery;
  const instrumentedQuery = () => emptyQuery();
  const claudeSdk = { query: originalQuery };

  const dependencies: LangfuseDependencies = {
    NodeSDK: class {
      constructor(config: ConstructorParameters<LangfuseDependencies["NodeSDK"]>[0]) {
        assert.equal(config.instrumentations.length, 1);
        assert.equal(config.spanProcessors.length, 1);
      }
      start() { started++; }
      async shutdown() { shutdowns++; }
    },
    LangfuseSpanProcessor: class {
      constructor(options: ConstructorParameters<LangfuseDependencies["LangfuseSpanProcessor"]>[0]) {
        filter = options.shouldExportSpan;
      }
    },
    isDefaultExportSpan: ((otelSpan: { instrumentationScope: { name: string } }) => {
      defaultFilterInput = otelSpan;
      return otelSpan.instrumentationScope.name === "default-scope";
    }),
    ClaudeAgentSDKInstrumentation: class {
      manuallyInstrument(
        module: Parameters<
          InstanceType<LangfuseDependencies["ClaudeAgentSDKInstrumentation"]>["manuallyInstrument"]
        >[0],
      ) {
        module.query = instrumentedQuery;
      }
    },
  };

  const observability = await startLangfuseObservability({
    claudeSdk,
    env: {
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    },
    loadDependencies: async () => dependencies,
  });

  assert.equal(observability.enabled, true);
  assert.notEqual(observability.claudeSdk, claudeSdk);
  assert.equal(observability.claudeSdk.query, instrumentedQuery);
  assert.equal(claudeSdk.query, originalQuery);
  assert.equal(started, 1);
  const defaultSpan = { instrumentationScope: { name: "default-scope" } };
  assert.equal(filter?.({ otelSpan: defaultSpan }), true);
  assert.equal(defaultFilterInput, defaultSpan);
  assert.equal(filter?.({ otelSpan: { instrumentationScope: { name: CLAUDE_AGENT_INSTRUMENTATION_SCOPE } } }), true);
  assert.equal(filter?.({ otelSpan: { instrumentationScope: { name: "unrelated" } } }), false);

  await observability.shutdown();
  await observability.shutdown();
  assert.equal(shutdowns, 1);
});

test("langfuse: 初始化失败时警告并回退到未包装 Claude SDK", async () => {
  const warnings: string[] = [];
  const claudeSdk = { query: emptyQuery };

  const observability = await startLangfuseObservability({
    claudeSdk,
    env: {
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    },
    loadDependencies: async () => {
      throw new Error("otel unavailable");
    },
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(observability.enabled, false);
  assert.equal(observability.claudeSdk, claudeSdk);
  assert.match(warnings[0] ?? "", /otel unavailable/);
});

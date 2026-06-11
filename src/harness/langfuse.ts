export const CLAUDE_AGENT_INSTRUMENTATION_SCOPE =
  "@arizeai/openinference-instrumentation-claude-agent-sdk";

export type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;

export interface ClaudeSdkModule {
  query: ClaudeQuery;
  [key: string]: unknown;
}

interface OtelSpanLike {
  instrumentationScope: { name: string };
}

interface SpanFilterInput {
  otelSpan: OtelSpanLike;
}

interface NodeSdkConfig {
  spanProcessors: unknown[];
  instrumentations: unknown[];
}

interface NodeSdkInstance {
  start(): void | Promise<void>;
  shutdown(): Promise<void>;
}

interface LangfuseSpanProcessorOptions {
  shouldExportSpan: (input: SpanFilterInput) => boolean;
}

interface ClaudeInstrumentationInstance {
  manuallyInstrument(module: ClaudeSdkModule): void;
}

export interface LangfuseDependencies {
  NodeSDK: new (config: NodeSdkConfig) => NodeSdkInstance;
  LangfuseSpanProcessor: new (options: LangfuseSpanProcessorOptions) => unknown;
  isDefaultExportSpan: (span: OtelSpanLike) => boolean;
  ClaudeAgentSDKInstrumentation: new () => ClaudeInstrumentationInstance;
}

export interface LangfuseObservability {
  enabled: boolean;
  claudeSdk: ClaudeSdkModule;
  shutdown(): Promise<void>;
}

export interface StartLangfuseOptions {
  claudeSdk: ClaudeSdkModule;
  env?: NodeJS.ProcessEnv;
  loadDependencies?: () => Promise<LangfuseDependencies>;
  onWarning?: (message: string) => void;
}

const OTEL_SDK_MODULE = "@opentelemetry/sdk-node";
const LANGFUSE_OTEL_MODULE = "@langfuse/otel";
const CLAUDE_INSTRUMENTATION_MODULE =
  "@arizeai/openinference-instrumentation-claude-agent-sdk";

async function loadLangfuseDependencies(): Promise<LangfuseDependencies> {
  const [otel, langfuse, openInference] = await Promise.all([
    import(OTEL_SDK_MODULE),
    import(LANGFUSE_OTEL_MODULE),
    import(CLAUDE_INSTRUMENTATION_MODULE),
  ]);
  return {
    NodeSDK: otel.NodeSDK,
    LangfuseSpanProcessor: langfuse.LangfuseSpanProcessor,
    isDefaultExportSpan: langfuse.isDefaultExportSpan,
    ClaudeAgentSDKInstrumentation: openInference.ClaudeAgentSDKInstrumentation,
  } as LangfuseDependencies;
}

function disabled(claudeSdk: ClaudeSdkModule): LangfuseObservability {
  return {
    enabled: false,
    claudeSdk,
    async shutdown() {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startLangfuseObservability(
  options: StartLangfuseOptions,
): Promise<LangfuseObservability> {
  const env = options.env ?? process.env;
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    return disabled(options.claudeSdk);
  }

  try {
    const dependencies = await (options.loadDependencies ?? loadLangfuseDependencies)();
    const instrumentedSdk: ClaudeSdkModule = { ...options.claudeSdk };
    const instrumentation = new dependencies.ClaudeAgentSDKInstrumentation();
    instrumentation.manuallyInstrument(instrumentedSdk);

    const spanProcessor = new dependencies.LangfuseSpanProcessor({
      shouldExportSpan: ({ otelSpan }) =>
        dependencies.isDefaultExportSpan(otelSpan) ||
        otelSpan.instrumentationScope.name === CLAUDE_AGENT_INSTRUMENTATION_SCOPE,
    });
    const sdk = new dependencies.NodeSDK({
      spanProcessors: [spanProcessor],
      instrumentations: [instrumentation],
    });
    await sdk.start();

    let stopped = false;
    return {
      enabled: true,
      claudeSdk: instrumentedSdk,
      async shutdown() {
        if (stopped) return;
        stopped = true;
        try {
          await sdk.shutdown();
        } catch (error) {
          options.onWarning?.(`Langfuse 关闭/上传失败: ${errorMessage(error)}`);
        }
      },
    };
  } catch (error) {
    options.onWarning?.(`Langfuse 初始化失败，已禁用观测: ${errorMessage(error)}`);
    return disabled(options.claudeSdk);
  }
}

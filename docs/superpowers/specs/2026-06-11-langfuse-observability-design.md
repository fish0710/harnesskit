# Langfuse Observability Design

## Goal

Add optional Langfuse tracing to the Claude Agent SDK driver so each Claude
query, model response, and tool call can be inspected without changing normal
Harness behavior when Langfuse is not configured.

## Version Requirements

- Node.js 20 or newer. `@langfuse/otel` 5.4.1 requires Node >=20.
- `@anthropic-ai/claude-agent-sdk` 0.3.170 or compatible.
- `@arizeai/openinference-instrumentation-claude-agent-sdk` 0.2.6.
- `@langfuse/otel` 5.4.1.
- `@opentelemetry/sdk-node` 0.218.0.

The OpenInference package was developed against Claude Agent SDK `^0.2.50`,
but its current V1 instrumentation wraps the public `query()` API. The selected
combination was verified to install together and wrap `query()` on Claude Agent
SDK 0.3.170. OpenInference carries some OpenTelemetry 1.x internals while
Langfuse and the Node SDK use OpenTelemetry 2.x; npm keeps those internal
dependencies isolated and shares the stable OpenTelemetry API package.

## Activation

Tracing is enabled only when both `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` are present. `LANGFUSE_BASE_URL` remains optional and is
handled by Langfuse, defaulting to its standard cloud endpoint.

If either required key is absent, Harness does not initialize OpenTelemetry and
the Claude driver runs exactly as before.

## Architecture

Create `src/harness/langfuse.ts` as the only module that knows about Langfuse,
OpenTelemetry, and OpenInference.

`startLangfuseObservability()` will:

1. Check environment configuration.
2. Dynamically import the optional observability packages.
3. Make a mutable copy of the Claude Agent SDK ESM namespace.
4. Manually instrument that copy with
   `ClaudeAgentSDKInstrumentation.manuallyInstrument()`.
5. Start a `NodeSDK` using `LangfuseSpanProcessor`.
6. Extend Langfuse's default export filter to include the Claude instrumentation
   scope.
7. Return the instrumented Claude SDK module and an idempotent `shutdown()`.

The Claude driver initializes this lifecycle lazily once, reuses the
instrumented `query()` across all retry rounds, and exposes an idempotent
`close()`. `runLoop()` always calls `close()` in `finally`, so buffered spans
are flushed once when the complete Harness run ends. Keeping one provider alive
across retries is required because the instrumentation cannot safely wrap the
same process repeatedly after shutdown.

## Failure Behavior

Observability must not affect task correctness:

- Missing Langfuse keys: silently disabled.
- Configured keys but missing/broken observability packages: print a warning
  through the driver's observation callback and continue without tracing.
- Export/network failure during shutdown: report a warning and preserve the
  Claude task result or original Claude error.

Claude Agent SDK failures remain task failures and are not swallowed.

## Data And Security

The integration captures prompts, model outputs, tool names, tool inputs,
tool outputs, token counts, cost, model, and SDK session ID. This can include
source code and command output. Operators must treat Langfuse as a destination
for potentially sensitive development data.

No Langfuse keys are written to project files or run records. Existing Langfuse
environment variables configure the exporter.

## Testing

Unit tests use dependency injection around the dynamic imports:

- Disabled when either required key is absent.
- Initializes instrumentation and NodeSDK when both keys exist.
- Includes the Claude instrumentation scope in the span filter.
- Reuses one instrumented `query()` across retry rounds and invokes shutdown
  once when the run loop ends.
- Initialization failure degrades to the original Claude SDK.

The full existing test suite must continue to pass.

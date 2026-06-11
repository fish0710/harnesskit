# Langfuse Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add environment-activated Langfuse tracing to the Claude driver without changing unconfigured runs.

**Architecture:** Isolate all OpenTelemetry and Langfuse setup in `src/harness/langfuse.ts`. The Claude driver lazily obtains one instrumented SDK module, reuses it across retry rounds, and exposes `close()` so `runLoop()` can shut the telemetry provider down in `finally`.

**Tech Stack:** TypeScript, Claude Agent SDK, OpenInference, OpenTelemetry Node SDK, Langfuse OTel.

---

### Task 1: Observability Lifecycle

**Files:**
- Create: `src/harness/langfuse.ts`
- Create: `test/langfuse.test.ts`

- [x] Write tests proving missing credentials disable tracing.
- [x] Run `npm run build` and confirm the missing module/API test fails.
- [x] Implement credential detection and a disabled lifecycle.
- [x] Write tests using injected fake modules to verify manual instrumentation,
      span filtering, SDK start, and SDK shutdown.
- [x] Implement the enabled lifecycle with dynamic imports and graceful fallback.
- [x] Run `npm run build && node --test dist/test/langfuse.test.js`.

### Task 2: Claude Driver Integration

**Files:**
- Modify: `src/harness/drivers.ts`
- Modify: `test/claude-driver.test.ts`
- Modify: `src/index.ts`

- [x] Add failing tests that the driver reuses the query function supplied by
      the observability lifecycle and shuts it down once after all iterations.
- [x] Integrate `startLangfuseObservability()` with driver `close()` and
      `runLoop()` cleanup in `finally`.
- [x] Export observability types needed by library consumers.
- [x] Run the focused driver and Langfuse tests.

### Task 3: Dependencies And Documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [x] Install exact compatible major/minor versions:
      `@langfuse/otel@5.4.1`,
      `@arizeai/openinference-instrumentation-claude-agent-sdk@0.2.6`, and
      `@opentelemetry/sdk-node@0.218.0`.
- [x] Set the package Node engine requirement to `>=20`.
- [x] Document environment variables, captured data, debug logging, and the
      version compatibility caveat.
- [x] Run `npm run check` with local-listener permissions and confirm all tests pass.

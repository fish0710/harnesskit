import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
  buildRunId,
  claudeObservabilityPaths,
  claudeObservabilityVolumeSubpath,
  loadDaytonaObservabilityConfig,
  mountedClaudeObservabilityPaths,
} from "../src/harness/observability.js";
import {
  RunRecorder,
  createRunRecorder,
  lastRunRecord,
  writeRunRecord,
} from "../src/harness/record.js";
import { RunRecorder as ExportedRunRecorder } from "../src/index.js";

test("Daytona Claude observability is default-on with stable defaults", () => {
  const config = loadDaytonaObservabilityConfig({});

  assert.deepEqual(config, {
    enabled: true,
    backend: "daytona-volume",
    volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
    mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  });
});

test("Daytona Claude observability can be explicitly disabled", () => {
  for (const value of ["0", "false", "off", " FALSE "]) {
    const config = loadDaytonaObservabilityConfig({
      HARNESS_DAYTONA_OBSERVABILITY: value,
    });

    assert.equal(config.enabled, false);
    assert.equal(config.backend, "disabled");
    assert.equal(config.volumeName, DEFAULT_DAYTONA_OBSERVABILITY_VOLUME);
    assert.equal(config.mountPath, DEFAULT_DAYTONA_OBSERVABILITY_MOUNT);
  }
});

test("Daytona Claude observability disable flag ignores stale invalid volume settings", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY: "0",
    HARNESS_DAYTONA_OBSERVABILITY_VOLUME: "   ",
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "relative/path",
  });

  assert.deepEqual(config, {
    enabled: false,
    backend: "disabled",
    volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
    mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  });
});

test("Daytona Claude observability rejects blank volume names and unsafe mounts", () => {
  assert.throws(
    () =>
      loadDaytonaObservabilityConfig({
        HARNESS_DAYTONA_OBSERVABILITY_VOLUME: "   ",
      }),
    /HARNESS_DAYTONA_OBSERVABILITY_VOLUME/,
  );

  for (const mountPath of ["", "relative/path", "/", "/tmp/\0bad"]) {
    assert.throws(
      () =>
        loadDaytonaObservabilityConfig({
          HARNESS_DAYTONA_OBSERVABILITY_MOUNT: mountPath,
        }),
      /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/,
    );
  }
});

test("buildRunId produces filesystem-safe sortable ids", () => {
  const runId = buildRunId(
    new Date("2026-06-16T12:00:00.123Z"),
    () => "12345678-90ab-cdef-1234-567890abcdef",
  );

  assert.equal(runId, "2026-06-16T12-00-00-123Z-12345678");
  assert.equal(runId.includes(":"), false);
  assert.equal(runId.includes("."), false);
});

test("buildRunId sanitizes caller-provided random id suffixes", () => {
  const runId = buildRunId(
    new Date("2026-06-16T12:00:00.123Z"),
    () => "../bad-id!@#456789",
  );

  assert.equal(runId, "2026-06-16T12-00-00-123Z-badid456");
  assert.equal(runId.includes("/"), false);
  assert.equal(runId.includes("!"), false);
});

test("claudeObservabilityPaths builds attempt scoped Claude config paths", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "/harness-observability/",
  });

  const paths = claudeObservabilityPaths(config, "run-1", 2);

  assert.deepEqual(paths, {
    runRoot: "/harness-observability/runs/run-1",
    attemptRoot: "/harness-observability/runs/run-1/attempt-2",
    claudeConfigDir: "/harness-observability/runs/run-1/attempt-2/.claude",
    manifestPath: "/harness-observability/runs/run-1/attempt-2/manifest.json",
  });
});

test("claudeObservabilityPaths rejects disabled config and invalid attempts", () => {
  const disabled = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY: "0",
  });

  assert.throws(
    () => claudeObservabilityPaths(disabled, "run-1", 1),
    /disabled/,
  );
  assert.throws(
    () =>
      claudeObservabilityPaths(
        loadDaytonaObservabilityConfig({}),
        "run-1",
        0,
      ),
    /attempt/,
  );
});

test("claudeObservabilityPaths rejects run ids that are not safe path segments", () => {
  const config = loadDaytonaObservabilityConfig({});

  for (const runId of ["", "../escape", "nested/run", "run\\id", "run\0id"]) {
    assert.throws(
      () => claudeObservabilityPaths(config, runId, 1),
      /runId/,
    );
  }
});

test("claudeObservabilityVolumeSubpath validates and scopes run volume subpaths", () => {
  assert.equal(
    claudeObservabilityVolumeSubpath("run-1"),
    "runs/run-1",
  );

  for (const runId of ["", "../escape", "nested/run", "run\\id", "run\0id"]) {
    assert.throws(
      () => claudeObservabilityVolumeSubpath(runId),
      /runId/,
    );
  }
});

test("mountedClaudeObservabilityPaths builds run-scoped sandbox paths", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "/harness-observability/",
  });

  const paths = mountedClaudeObservabilityPaths(config, 2);

  assert.deepEqual(paths, {
    runRoot: "/harness-observability",
    attemptRoot: "/harness-observability/attempt-2",
    claudeConfigDir: "/harness-observability/.claude",
    manifestPath: "/harness-observability/attempt-2/manifest.json",
  });
});

test("mountedClaudeObservabilityPaths rejects disabled config and invalid attempts", () => {
  const disabled = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY: "0",
  });

  assert.throws(
    () => mountedClaudeObservabilityPaths(disabled, 1),
    /disabled/,
  );
  assert.throws(
    () => mountedClaudeObservabilityPaths(loadDaytonaObservabilityConfig({}), 0),
    /attempt/,
  );
});

test("createRunRecorder writes an initial v2 manifest before agent execution", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-observability-record-"));
  const recorder = createRunRecorder(cwd, {
    runId: "run-1",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "persist every Claude artifact",
    driver: "daytona(claude)",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-1",
    },
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.runId, "run-1");
  assert.equal(parsed.status, "running");
  assert.equal(parsed.task, "persist every Claude artifact");
  assert.deepEqual(parsed.attempts, []);
  assert.equal(parsed.events[0].event, "run.record.created");
});

test("RunRecorder records attempts, gate ids, final outcome, and raw event data", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-observability-record-"));
  const recorder = createRunRecorder(cwd, {
    runId: "run-2",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "keep secrets if tools print them",
    driver: "daytona(claude)",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-2",
    },
  });

  recorder.recordEvent("agent.command.start", {
    attempt: 1,
    id: "agent-1",
    claudeConfigDir: "/harness-observability/runs/run-2/attempt-1/.claude",
    secretPrintedByTool: "raw-secret-kept",
  });
  recorder.recordEvent("agent.command.end", {
    attempt: 1,
    id: "agent-1",
    exitCode: 0,
  });
  recorder.recordEvent("gate.create.end", {
    attempt: 1,
    id: "gate-1",
  });
  recorder.recordEvent("gate.run.end", {
    attempt: 1,
    id: "gate-1",
    outcome: "pass",
  });
  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.outcome, "ready_for_mr");
  assert.equal(parsed.attempts[0].agentSandboxId, "agent-1");
  assert.equal(parsed.attempts[0].exitCode, 0);
  assert.deepEqual(parsed.attempts[0].gateSandboxIds, ["gate-1"]);
  assert.equal(parsed.attempts[0].gateOutcome, "pass");
  assert.match(JSON.stringify(parsed), /raw-secret-kept/);
});

test("lastRunRecord reads both legacy v1 and v2 records", () => {
  const legacyCwd = mkdtempSync(join(tmpdir(), "harness-record-v1-"));
  writeRunRecord(legacyCwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });

  assert.equal(lastRunRecord(legacyCwd)?.task, "legacy");
  assert.equal(lastRunRecord(legacyCwd)?.outcome, "blocked");

  const v2Cwd = mkdtempSync(join(tmpdir(), "harness-record-v2-"));
  const recorder = createRunRecorder(v2Cwd, {
    runId: "2026-06-16T12-00-00-000Z-abcdef12",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "v2",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  recorder.complete({
    outcome: "escalated",
    attempts: 2,
    summary: { total: 1, pass: 0, fail: 1, error: 0, needsReview: 0 },
  });

  const last = lastRunRecord(v2Cwd);

  assert.equal(last?.at, "2026-06-16T12:00:00.000Z");
  assert.equal(last?.task, "v2");
  assert.equal(last?.driver, "daytona(claude)");
  assert.equal(last?.outcome, "escalated");
  assert.equal(last?.attempts, 2);
});

test("root export includes the RunRecorder class", () => {
  assert.equal(ExportedRunRecorder, RunRecorder);
});

test("lastRunRecord ignores non-completed v2 records even with stale outcome fields", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-v2-error-"));
  const recorder = createRunRecorder(cwd, {
    runId: "2026-06-16T12-00-00-000Z-error12",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "error after completion",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });

  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  });
  recorder.fail(new Error("late failure"));

  assert.equal(lastRunRecord(cwd), undefined);
});

test("createRunRecorder rejects run ids that are unsafe file names", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-unsafe-run-id-"));

  for (const runId of ["", ".", "..", "../escape", "nested/run", "run\\id", "run\0id"]) {
    assert.throws(
      () =>
        createRunRecorder(cwd, {
          runId,
          createdAt: "2026-06-16T12:00:00.000Z",
          task: "unsafe",
          driver: "daytona(claude)",
          observability: {
            enabled: false,
            backend: "disabled",
            volumeName: "harness-claude-observability",
            mountPath: "/harness-observability",
          },
        }),
      /runId/,
    );
  }
});

test("lastRunRecord scans backward past incompatible v2 records", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-v2-scan-"));
  const completed = createRunRecorder(cwd, {
    runId: "2026-06-16T12-00-00-000Z-aaaa1111",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "completed",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  completed.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  });
  createRunRecorder(cwd, {
    runId: "2026-06-16T12-01-00-000Z-bbbb2222",
    createdAt: "2026-06-16T12:01:00.000Z",
    task: "still running",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "completed");
  assert.equal(last?.outcome, "ready_for_mr");
});

test("RunRecorder snapshots event data into JSON-safe values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-json-event-"));
  const recorder = createRunRecorder(cwd, {
    runId: "json-event",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "json event",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  const eventData: Record<string, unknown> = {
    attempt: 1,
    id: "agent-1",
    nested: { value: "before" },
    count: 1n,
    missing: undefined,
  };
  eventData.self = eventData;

  recorder.recordEvent("agent.command.start", eventData);
  (eventData.nested as { value: string }).value = "after";
  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));
  const data = parsed.events.find(
    (event: { event: string }) => event.event === "agent.command.start",
  ).data;

  assert.equal(data.nested.value, "before");
  assert.equal(data.count, "1");
  assert.equal(data.missing, null);
  assert.equal(data.self, "[circular]");
});

test("RunRecorder snapshots completion summary and action", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-complete-snapshot-"));
  const recorder = createRunRecorder(cwd, {
    runId: "complete-snapshot",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "completion snapshot",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  const summary = {
    total: 1,
    pass: 1,
    fail: 0,
    error: 0,
    needsReview: 0,
  };
  const action = { kind: "stop_for_human" as const, reason: "before" };

  recorder.complete({
    outcome: "escalated",
    attempts: 1,
    summary,
    action,
  });
  summary.pass = 0;
  action.reason = "after";
  recorder.recordEvent("agent.command.end", { attempt: 1, exitCode: 0 });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.summary.pass, 1);
  assert.equal(parsed.action.reason, "before");
});

test("lastRunRecord skips malformed legacy and future schema records", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-skip-malformed-"));
  writeRunRecord(cwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy valid",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  writeFileSync(
    join(cwd, ".harness", "runs", "2026-06-16T12-00-00-000Z-future.json"),
    JSON.stringify({ schemaVersion: 3, task: "future" }),
    "utf8",
  );
  writeFileSync(
    join(cwd, ".harness", "runs", "2026-06-16T12-01-00-000Z-malformed.json"),
    JSON.stringify({ task: "malformed" }),
    "utf8",
  );

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "legacy valid");
  assert.equal(last?.outcome, "blocked");
});

test("lastRunRecord selects newest compatible record by record timestamp", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-timestamp-order-"));
  const old = createRunRecorder(cwd, {
    runId: "z-old",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "old",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  old.complete({
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  const newer = createRunRecorder(cwd, {
    runId: "a-new",
    createdAt: "2026-06-16T12:01:00.000Z",
    task: "new",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  newer.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  });

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "new");
  assert.equal(last?.outcome, "ready_for_mr");
});

test("lastRunRecord skips shaped records with invalid timestamps", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-invalid-time-"));
  writeRunRecord(cwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy valid",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  writeFileSync(
    join(cwd, ".harness", "runs", "z-invalid-v1.json"),
    JSON.stringify({
      at: "not-a-date",
      task: "invalid v1",
      driver: "scaffold",
      outcome: "ready_for_mr",
      attempts: 1,
      summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    }),
    "utf8",
  );
  writeFileSync(
    join(cwd, ".harness", "runs", "z-invalid-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "z-invalid-v2",
      createdAt: "not-a-date",
      updatedAt: "not-a-date",
      task: "invalid v2",
      driver: "daytona(claude)",
      status: "completed",
      observability: {
        enabled: false,
        backend: "disabled",
        volumeName: "harness-claude-observability",
        mountPath: "/harness-observability",
      },
      attempts: [],
      attemptCount: 1,
      events: [],
      outcome: "ready_for_mr",
      summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    }),
    "utf8",
  );
  writeFileSync(
    join(cwd, ".harness", "runs", "z-lax-date-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "z-lax-date-v2",
      createdAt: "1",
      updatedAt: "1",
      task: "lax date v2",
      driver: "daytona(claude)",
      status: "completed",
      observability: {
        enabled: false,
        backend: "disabled",
        volumeName: "harness-claude-observability",
        mountPath: "/harness-observability",
      },
      attempts: [],
      attemptCount: 1,
      events: [],
      outcome: "ready_for_mr",
      summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    }),
    "utf8",
  );
  writeFileSync(
    join(cwd, ".harness", "runs", "z-impossible-date-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "z-impossible-date-v2",
      createdAt: "2026-02-31T00:00:00.000Z",
      updatedAt: "2026-02-31T00:00:00.000Z",
      task: "impossible date v2",
      driver: "daytona(claude)",
      status: "completed",
      observability: {
        enabled: false,
        backend: "disabled",
        volumeName: "harness-claude-observability",
        mountPath: "/harness-observability",
      },
      attempts: [],
      attemptCount: 1,
      events: [],
      outcome: "ready_for_mr",
      summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    }),
    "utf8",
  );

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "legacy valid");
  assert.equal(last?.outcome, "blocked");
});

test("lastRunRecord skips v2 records with invalid attempt counts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-invalid-attempts-"));
  writeRunRecord(cwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy valid",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  for (const [name, attemptCount] of [
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    writeFileSync(
      join(cwd, ".harness", "runs", `z-${name}-attempts-v2.json`),
      JSON.stringify({
        schemaVersion: 2,
        runId: `z-${name}-attempts-v2`,
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
        task: `${name} attempts`,
        driver: "daytona(claude)",
        status: "completed",
        observability: {
          enabled: false,
          backend: "disabled",
          volumeName: "harness-claude-observability",
          mountPath: "/harness-observability",
        },
        attempts: [],
        attemptCount,
        events: [],
        outcome: "ready_for_mr",
        summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
      }),
      "utf8",
    );
  }

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "legacy valid");
  assert.equal(last?.outcome, "blocked");
});

test("lastRunRecord skips v2 records with malformed manifest envelopes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-malformed-v2-envelope-"));
  writeRunRecord(cwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy valid",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  const validV2 = {
    schemaVersion: 2,
    runId: "z-malformed-v2",
    createdAt: "2026-06-16T12:00:00.000Z",
    updatedAt: "2026-06-16T12:00:00.000Z",
    task: "malformed v2",
    driver: "daytona(claude)",
    status: "completed",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    attempts: [],
    attemptCount: 1,
    events: [],
    outcome: "ready_for_mr",
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
  };
  for (const [name, override] of [
    ["missing-run-id", { runId: undefined }],
    ["invalid-updated-at", { updatedAt: "not-a-date" }],
    ["missing-observability", { observability: undefined }],
    ["missing-events", { events: undefined }],
  ] as const) {
    writeFileSync(
      join(cwd, ".harness", "runs", `z-${name}.json`),
      JSON.stringify({ ...validV2, ...override }),
      "utf8",
    );
  }

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "legacy valid");
  assert.equal(last?.outcome, "blocked");
});

test("lastRunRecord skips v2 records with invalid attempts arrays", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-invalid-v2-attempts-array-"));
  writeRunRecord(cwd, {
    at: "2026-06-16T11:00:00.000Z",
    task: "legacy valid",
    driver: "scaffold",
    outcome: "blocked",
    attempts: 1,
    summary: { total: 1, pass: 0, fail: 0, error: 0, needsReview: 1 },
  });
  for (const [name, attempts] of [
    ["missing", undefined],
    ["string", "bad"],
  ] as const) {
    writeFileSync(
      join(cwd, ".harness", "runs", `z-${name}-attempts-array-v2.json`),
      JSON.stringify({
        schemaVersion: 2,
        runId: `z-${name}-attempts-array-v2`,
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
        task: `${name} attempts array`,
        driver: "daytona(claude)",
        status: "completed",
        observability: {
          enabled: false,
          backend: "disabled",
          volumeName: "harness-claude-observability",
          mountPath: "/harness-observability",
        },
        attempts,
        events: [],
        outcome: "ready_for_mr",
        summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
      }),
      "utf8",
    );
  }

  const last = lastRunRecord(cwd);

  assert.equal(last?.task, "legacy valid");
  assert.equal(last?.outcome, "blocked");
});

test("RunRecorder preserves repeated non-cyclic object references", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-record-repeated-ref-"));
  const recorder = createRunRecorder(cwd, {
    runId: "repeated-reference",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "repeated reference",
    driver: "daytona(claude)",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
  });
  const shared = { value: "kept" };

  recorder.recordEvent("agent.command.start", {
    attempt: 1,
    first: shared,
    second: shared,
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));
  const data = parsed.events.find(
    (event: { event: string }) => event.event === "agent.command.start",
  ).data;

  assert.deepEqual(data.first, { value: "kept" });
  assert.deepEqual(data.second, { value: "kept" });
});

test("RunRecorder records Claude session resume metadata", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-observability-record-"));
  const recorder = createRunRecorder(cwd, {
    runId: "run-claude-session",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "resume Claude session metadata",
    driver: "daytona(claude)",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-claude-session",
    },
  });

  recorder.recordEvent("agent.command.start", {
    attempt: 1,
    claudeConfigDir: "/harness-observability/.claude",
    resume: false,
  });
  recorder.recordEvent("agent.command.end", {
    attempt: 1,
    exitCode: 0,
    claudeSessionId: "session-abc",
    resume: false,
  });
  recorder.recordEvent("agent.command.start", {
    attempt: 2,
    claudeConfigDir: "/harness-observability/.claude",
    claudeSessionId: "session-abc",
    resume: true,
  });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.attempts[0].claudeSessionId, "session-abc");
  assert.equal(parsed.attempts[1].resumedFromSessionId, "session-abc");
  assert.equal(parsed.attempts[1].claudeConfigDir, "/harness-observability/.claude");
});

test("RunRecorder ignores unknown attempt events for attempt summaries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-observability-record-"));
  const recorder = createRunRecorder(cwd, {
    runId: "run-unknown-attempt-events",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "ignore unknown attempt metadata",
    driver: "daytona(claude)",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-unknown-attempt-events",
    },
  });

  recorder.recordEvent("tool.output", {
    attempt: 1,
    claudeSessionId: "session-leak",
  });
  recorder.recordEvent("progress", { attempt: 2 });

  const parsed = JSON.parse(readFileSync(recorder.path, "utf8"));

  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[1].event, "tool.output");
  assert.equal(parsed.events[2].event, "progress");
  assert.deepEqual(parsed.attempts, []);

  const existingAttemptCwd = mkdtempSync(join(tmpdir(), "harness-observability-record-"));
  const existingAttemptRecorder = createRunRecorder(existingAttemptCwd, {
    runId: "run-existing-attempt-unknown-events",
    createdAt: "2026-06-16T12:00:00.000Z",
    task: "ignore unknown attempt metadata on existing attempts",
    driver: "daytona(claude)",
    observability: {
      enabled: true,
      backend: "daytona-volume",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      runRoot: "/harness-observability/runs/run-existing-attempt-unknown-events",
    },
  });

  existingAttemptRecorder.recordEvent("agent.command.start", {
    id: "agent-1",
    attempt: 1,
    claudeConfigDir: "/harness-observability/.claude",
  });
  existingAttemptRecorder.recordEvent("tool.output", {
    attempt: 1,
    claudeSessionId: "session-leak",
    gateOutcome: "pass",
  });

  const parsedExistingAttempt = JSON.parse(
    readFileSync(existingAttemptRecorder.path, "utf8"),
  );

  assert.equal(parsedExistingAttempt.events.length, 3);
  assert.equal(parsedExistingAttempt.events[2].event, "tool.output");
  assert.equal(parsedExistingAttempt.attempts.length, 1);

  const existingAttempt = parsedExistingAttempt.attempts[0] as Record<string, unknown>;

  assert.deepEqual(Object.keys(existingAttempt).sort(), [
    "agentSandboxId",
    "attempt",
    "claudeConfigDir",
    "gateSandboxIds",
    "startedAt",
  ]);
  assert.deepEqual(existingAttempt, {
    attempt: 1,
    agentSandboxId: "agent-1",
    claudeConfigDir: "/harness-observability/.claude",
    startedAt: existingAttempt.startedAt,
    gateSandboxIds: [],
  });
  assert.equal(
    (existingAttempt as Record<string, unknown>)["claudeSessionId"],
    undefined,
  );
  assert.equal(
    (existingAttempt as Record<string, unknown>)["resumedFromSessionId"],
    undefined,
  );
  assert.equal(
    (existingAttempt as Record<string, unknown>)["gateOutcome"],
    undefined,
  );
});

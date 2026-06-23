import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RunStore,
  lastRunRecord,
  type RunRecordObservability,
} from "../src/harness/record.js";
import type { GateReport } from "../src/types.js";

const disabledObservability: RunRecordObservability = {
  enabled: false,
  backend: "disabled",
  volumeName: "harness-claude-observability",
  mountPath: "/harness-observability",
};

function passReport(): GateReport {
  return {
    outcome: "pass",
    results: [
      {
        id: "smoke.boot",
        type: "command",
        status: "pass",
        durationMs: 1,
        violations: [],
      },
    ],
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    pendingDecisions: [],
    exitCode: 0,
  };
}

test("RunStore writes a v3 run before execution and completes with full outcome artifacts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-run-store-"));
  const store = new RunStore(cwd, {
    now: () => "2026-06-18T12:00:00.000Z",
    makeRunId: () => "run-store-1",
    repoInfo: () => ({
      root: cwd,
      gitRoot: cwd,
      branch: "main",
      head: "abc123",
      dirty: false,
    }),
  });

  const recorder = store.startRun({
    kind: "single",
    task: {
      description: "implement health check",
      taskId: "health-check",
    },
    driver: "daytona(command)",
    observability: disabledObservability,
    selectedContracts: ["smoke.boot"],
  });

  const initial = JSON.parse(readFileSync(recorder.path, "utf8"));
  assert.equal(initial.schemaVersion, 3);
  assert.equal(initial.runId, "run-store-1");
  assert.equal(initial.status, "running");
  assert.equal(initial.kind, "single");
  assert.equal(initial.task.description, "implement health check");
  assert.equal(initial.task.taskId, "health-check");
  assert.deepEqual(initial.selectedContracts, ["smoke.boot"]);
  assert.deepEqual(initial.repo, {
    root: cwd,
    gitRoot: cwd,
    branch: "main",
    head: "abc123",
    dirty: false,
  });

  const report = passReport();
  recorder.recordEvent("run.loop.log", { line: "第 1 轮" });
  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: report.summary,
    report,
    logs: ["第 1 轮", "门禁: pass"],
    publication: {
      ok: true,
      changedFiles: ["src/server.ts"],
    },
  });

  const completed = store.readRun("run-store-1");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.attemptCount, 1);
  assert.equal(completed?.report?.results[0]?.id, "smoke.boot");
  assert.deepEqual(completed?.logs, ["第 1 轮", "门禁: pass"]);
  assert.deepEqual(completed?.publication, {
    ok: true,
    changedFiles: ["src/server.ts"],
  });

  assert.equal(lastRunRecord(cwd)?.task, "implement health check");
  assert.deepEqual(
    store.listRuns({ taskId: "health-check" }).map((run) => run.runId),
    ["run-store-1"],
  );
});

test("RunStore rejects v3 records with invalid optional fields", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-run-store-invalid-v3-"));
  const store = new RunStore(cwd, {
    now: () => "2026-06-18T12:00:00.000Z",
    makeRunId: () => "run-store-invalid",
    repoInfo: () => ({ root: cwd }),
  });
  const recorder = store.startRun({
    kind: "single",
    task: { description: "invalid optional fields" },
    driver: "scaffold",
    observability: disabledObservability,
  });
  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: passReport().summary,
    logs: ["ok"],
  });

  const record = JSON.parse(readFileSync(recorder.path, "utf8")) as Record<string, unknown>;
  record.logs = "not an array";
  record.diagnosticLogPath = 42;
  writeFileSync(recorder.path, JSON.stringify(record, null, 2), "utf8");

  assert.equal(store.readRun("run-store-invalid"), undefined);
  assert.deepEqual(store.listRuns(), []);
});

test("RunStore persists and reads diagnostic log path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-run-store-diagnostic-log-"));
  const store = new RunStore(cwd, {
    now: () => "2026-06-18T12:00:00.000Z",
    makeRunId: () => "run-store-diagnostic-log",
    repoInfo: () => ({ root: cwd }),
  });
  const recorder = store.startRun({
    kind: "single",
    task: { description: "verbose run" },
    driver: "scaffold",
    observability: disabledObservability,
  });

  const diagnosticLogPath = join(
    cwd,
    ".harness",
    "runs",
    "run-store-diagnostic-log.log.jsonl",
  );
  recorder.setDiagnosticLogPath(diagnosticLogPath);
  recorder.complete({
    outcome: "ready_for_mr",
    attempts: 1,
    summary: passReport().summary,
    logs: ["ok"],
  });

  const completed = store.readRun("run-store-diagnostic-log");
  assert.equal(completed?.diagnosticLogPath, diagnosticLogPath);
});

test("RunStore rejects malformed series v3 metadata", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-run-store-invalid-series-"));
  const store = new RunStore(cwd, {
    now: () => "2026-06-18T12:00:00.000Z",
    makeRunId: () => "series-task-invalid",
    repoInfo: () => ({ root: cwd }),
  });

  assert.throws(
    () => store.startRun({
      kind: "series-task",
      task: { description: "missing series task metadata" },
      driver: "scaffold",
      observability: disabledObservability,
    }),
    /series-task/,
  );

  const valid = store.startRun({
    runId: "series-task-valid",
    kind: "series-task",
    parentRunId: "series-parent",
    task: {
      description: "valid child",
      taskId: "one",
      seriesId: "series",
      index: 1,
      total: 1,
    },
    driver: "scaffold",
    observability: disabledObservability,
  });
  const record = JSON.parse(readFileSync(valid.path, "utf8")) as Record<string, unknown>;
  delete record.parentRunId;
  writeFileSync(valid.path, JSON.stringify(record, null, 2), "utf8");

  assert.equal(store.readRun("series-task-valid"), undefined);
  assert.deepEqual(store.listRuns(), []);
});

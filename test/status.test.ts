import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RunStore, type RunRecordObservability } from "../src/harness/record.js";
import { gatherStatus } from "../src/harness/status.js";

const disabledObservability: RunRecordObservability = {
  enabled: false,
  backend: "disabled",
  volumeName: "harness-claude-observability",
  mountPath: "/harness-observability",
};

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

test("gatherStatus reports latest v3 series completion instead of older child run", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-status-latest-run-"));
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "smoke.boot.json"), {
    id: "smoke.boot",
    type: "command",
    cmd: "true",
  });

  const oldChild = new RunStore(cwd, {
    now: () => "2026-06-22T10:00:00.000Z",
    makeRunId: () => "old-escalated-child",
    repoInfo: () => ({ root: cwd }),
  }).startRun({
    kind: "series-task",
    parentRunId: "old-series-parent",
    task: {
      description: "old dependency task",
      taskId: "vue3-deps",
      seriesId: "dependency-stabilization",
      index: 1,
      total: 1,
    },
    driver: "daytona(claude)",
    observability: disabledObservability,
  });
  oldChild.complete({
    outcome: "escalated",
    attempts: 3,
    summary: { total: 1, pass: 0, fail: 1, error: 0, needsReview: 0 },
  });

  const currentSeries = new RunStore(cwd, {
    now: () => "2026-06-23T01:00:00.000Z",
    makeRunId: () => "current-series",
    repoInfo: () => ({ root: cwd }),
  }).startRun({
    kind: "series",
    task: {
      description: "task series dependency-stabilization",
      seriesId: "dependency-stabilization",
      total: 1,
    },
    driver: "series(claude)",
    observability: disabledObservability,
  });
  currentSeries.complete({
    outcome: "completed",
    attempts: 1,
    summary: { total: 1, pass: 1, fail: 0, error: 0, needsReview: 0 },
    logs: ["series completed"],
  });

  const output = gatherStatus(cwd, contractsDir).join("\n");

  assert.match(output, /最近一次 run: 2026-06-23T01:00:00\.000Z/);
  assert.match(output, /kind=series/);
  assert.match(output, /completed\/completed/);
  assert.doesNotMatch(output, /old dependency task/);
  assert.doesNotMatch(output, /escalated/);
});

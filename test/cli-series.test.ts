import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadTaskSeriesConfig,
  taskHash,
  writeSeriesLedger,
} from "../src/harness/series.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

function projectFixture(options?: {
  includeFailingUnselected?: boolean;
  config?: unknown;
}): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-run-"));
  const contractsDir = join(cwd, "contracts");

  writeJson(join(contractsDir, "smoke.boot.json"), {
    id: "smoke.boot",
    type: "command",
    stage: "smoke",
    cmd: "true",
  });
  writeJson(join(contractsDir, "domain.model-boundary.json"), {
    id: "domain.model-boundary",
    type: "command",
    stage: "domain",
    cmd: "true",
  });
  if (options?.includeFailingUnselected) {
    writeJson(join(contractsDir, "unselected.fail.json"), {
      id: "unselected.fail",
      type: "command",
      stage: "unselected",
      cmd: "false",
    });
  }
  if (options?.config !== undefined) {
    writeJson(join(cwd, "harness.config.json"), options.config);
  }

  return { cwd, contractsDir };
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function runCliWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

type RunRecordFixture = {
  runId?: string;
  schemaVersion?: unknown;
  kind?: unknown;
  parentRunId?: unknown;
  status?: unknown;
  driver?: unknown;
  outcome?: unknown;
  attemptCount?: unknown;
  errorReason?: unknown;
  selectedContracts?: unknown;
  logs?: unknown;
  children?: Array<{
    runId?: unknown;
    taskId?: unknown;
    index?: unknown;
    status?: unknown;
    outcome?: unknown;
  }>;
  summary?: {
    total?: unknown;
    pass?: unknown;
    fail?: unknown;
    error?: unknown;
    needsReview?: unknown;
  };
  task?: {
    description?: unknown;
    taskId?: unknown;
    seriesId?: unknown;
    index?: unknown;
    total?: unknown;
  };
};

function runRecords(cwd: string): RunRecordFixture[] {
  return readdirSync(join(cwd, ".harness", "runs"))
    .filter((file) => file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(join(cwd, ".harness", "runs", file), "utf8")) as RunRecordFixture
    );
}

test("CLI run with explicit task keeps single-task behavior even when config has tasks", () => {
  const { cwd, contractsDir } = projectFixture({
    config: {
      tasks: [{ id: "configured", task: "Configured task." }],
    },
  });

  const result = runCli(cwd, [
    "run",
    "Explicit task.",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /task="Explicit task\."/);
  assert.doesNotMatch(result.stdout, /series/);
});

test("CLI run without task consumes configured task series", () => {
  const { cwd, contractsDir } = projectFixture({
    includeFailingUnselected: true,
    config: {
      series: { id: "order-refactor" },
      taskDefaults: { gate: { contracts: ["smoke.boot"] } },
      autoCommit: { enabled: false },
      tasks: [
        { id: "one", task: "First task." },
        {
          id: "two",
          task: "Second task.",
          gate: { contracts: ["domain.model-boundary"] },
        },
      ],
    },
  });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /harness series · id=order-refactor · tasks=2/);
  assert.match(result.stdout, /\[1\/2\] one/);
  assert.match(result.stdout, /\[2\/2\] two/);

  const ledger = JSON.parse(
    readFileSync(join(cwd, ".harness/series/order-refactor.json"), "utf8"),
  ) as {
    status?: unknown;
    tasks?: Array<{ id?: unknown; status?: unknown }>;
  };
  assert.equal(ledger.status, "completed");
  assert.deepEqual(
    ledger.tasks?.map((task) => ({ id: task.id, status: task.status })),
    [
      { id: "one", status: "completed" },
      { id: "two", status: "completed" },
    ],
  );

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  assert.equal(parent?.schemaVersion, 3);
  assert.equal(parent?.task?.seriesId, "order-refactor");

  const children = records
    .filter((record) => record.kind === "series-task")
    .sort((a, b) => Number(a.task?.index) - Number(b.task?.index));
  assert.equal(children.length, 2);
  assert.deepEqual(
    parent?.children?.map((child) => ({
      runId: child.runId,
      taskId: child.taskId,
      index: child.index,
      status: child.status,
      outcome: child.outcome,
    })),
    children.map((child) => ({
      runId: child.runId,
      taskId: child.task?.taskId,
      index: child.task?.index,
      status: child.status,
      outcome: child.outcome,
    })),
  );
  assert.deepEqual(
    children.map((record) => ({
      parentRunId: record.parentRunId,
      taskId: record.task?.taskId,
      seriesId: record.task?.seriesId,
      index: record.task?.index,
      total: record.task?.total,
    })),
    [
      {
        parentRunId: parent?.runId,
        taskId: "one",
        seriesId: "order-refactor",
        index: 1,
        total: 2,
      },
      {
        parentRunId: parent?.runId,
        taskId: "two",
        seriesId: "order-refactor",
        index: 2,
        total: 2,
      },
    ],
  );
});

test("CLI series reports completed matching tasks skipped from the ledger", () => {
  const harnessConfig = {
    series: { id: "dependency-stabilization" },
    autoCommit: { enabled: false },
    tasks: [
      {
        id: "vue3-deps",
        task: "Stabilize Vue 3 dependency lockfile.",
        gate: { contracts: ["smoke.boot"] },
      },
    ],
  };
  const { cwd, contractsDir } = projectFixture({ config: harnessConfig });
  const config = loadTaskSeriesConfig(harnessConfig)!;
  const now = "2026-06-23T00:00:00.000Z";
  writeSeriesLedger(cwd, {
    schemaVersion: 1,
    seriesId: config.seriesId,
    status: "completed",
    configHash: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    tasks: [
      {
        id: "vue3-deps",
        taskHash: taskHash(config.tasks[0]!, config.autoCommit, config.taskDefaults),
        status: "completed",
        changedFiles: ["vue3-app/package.json", "vue3-app/package-lock.json"],
        runRecord: ".harness/runs/old-child.json",
        completedAt: now,
      },
    ],
  });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /\[1\/1\] vue3-deps · skipped completed \(taskHash unchanged\)/,
  );
  assert.doesNotMatch(result.stdout, /harness run · task=/);

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  assert.equal(parent?.outcome, "completed");
  assert.deepEqual(parent?.logs, [
    "series completed",
    "skipped completed tasks: vue3-deps",
  ]);
  assert.equal(records.some((record) => record.kind === "series-task"), false);
});

test("CLI series parent record summarizes completed and blocked child outcomes", () => {
  const { cwd, contractsDir } = projectFixture({
    config: {
      series: { id: "decision-series" },
      autoCommit: { enabled: false },
      tasks: [
        { id: "one", task: "Passing task.", gate: { contracts: ["smoke.boot"] } },
        { id: "two", task: "Needs a decision.", gate: { contracts: ["review.decision"] } },
      ],
    },
  });
  writeJson(join(contractsDir, "review.decision.json"), {
    id: "review.decision",
    type: "review",
    scenario: "needs product decision",
  });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stdout, /series stopped at two: blocked/);

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  assert.equal(parent?.status, "completed");
  assert.equal(parent?.outcome, "blocked");
  assert.equal(parent?.attemptCount, 2);
  assert.deepEqual(parent?.summary, {
    total: 2,
    pass: 1,
    fail: 0,
    error: 0,
    needsReview: 1,
  });

  const children = records
    .filter((record) => record.kind === "series-task")
    .sort((a, b) => Number(a.task?.index) - Number(b.task?.index));
  assert.deepEqual(
    children.map((record) => ({
      taskId: record.task?.taskId,
      status: record.status,
      outcome: record.outcome,
      selectedContracts: record.selectedContracts,
    })),
    [
      {
        taskId: "one",
        status: "completed",
        outcome: "ready_for_mr",
        selectedContracts: ["smoke.boot"],
      },
      {
        taskId: "two",
        status: "completed",
        outcome: "blocked",
        selectedContracts: ["review.decision"],
      },
    ],
  );
  assert.deepEqual(
    parent?.children?.map((child) => ({
      runId: child.runId,
      taskId: child.taskId,
      status: child.status,
      outcome: child.outcome,
    })),
    children.map((child) => ({
      runId: child.runId,
      taskId: child.task?.taskId,
      status: child.status,
      outcome: child.outcome,
    })),
  );
});

test("CLI series records Claude setup failures on the child run with series metadata", () => {
  const { cwd, contractsDir } = projectFixture({
    config: {
      series: { id: "claude-series" },
      autoCommit: { enabled: false },
      tasks: [{ id: "one", task: "Claude task.", gate: { contracts: ["smoke.boot"] } }],
    },
  });

  const result = runCliWithEnv(
    cwd,
    [
      "run",
      "--driver",
      "claude",
      "--dir",
      contractsDir,
    ],
    { HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "relative/path" },
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/);

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.outcome, "error");
  assert.match(String(parent?.errorReason), /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/);

  const child = records.find((record) => record.kind === "series-task");
  assert.equal(child?.parentRunId, parent?.runId);
  assert.equal(child?.task?.taskId, "one");
  assert.equal(child?.task?.seriesId, "claude-series");
  assert.equal(child?.task?.index, 1);
  assert.equal(child?.task?.total, 1);
  assert.equal(child?.driver, "daytona(claude)");
  assert.equal(child?.status, "error");
  assert.match(String(child?.errorReason), /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/);
  assert.deepEqual(parent?.children?.map((child) => child.runId), [child?.runId]);
});

test("CLI series records child errors when task contract selection fails", () => {
  const { cwd, contractsDir } = projectFixture({
    config: {
      series: { id: "selector-series" },
      autoCommit: { enabled: false },
      tasks: [
        {
          id: "one",
          task: "Select missing contract.",
          gate: { contracts: ["missing.contract"] },
        },
      ],
    },
  });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /未知契约: missing\.contract/);

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  const child = records.find((record) => record.kind === "series-task");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.outcome, "error");
  assert.equal(child?.parentRunId, parent?.runId);
  assert.equal(child?.task?.taskId, "one");
  assert.equal(child?.task?.seriesId, "selector-series");
  assert.equal(child?.task?.index, 1);
  assert.equal(child?.task?.total, 1);
  assert.equal(child?.status, "error");
  assert.equal(child?.outcome, "error");
  assert.deepEqual(child?.selectedContracts, []);
  assert.match(String(child?.errorReason), /未知契约: missing\.contract/);
  assert.deepEqual(parent?.children?.map((entry) => entry.runId), [child?.runId]);
});

test("CLI series records parent errors when contracts cannot be loaded", () => {
  const { cwd } = projectFixture({
    config: {
      series: { id: "missing-contracts-series" },
      autoCommit: { enabled: false },
      tasks: [{ id: "one", task: "Needs contracts." }],
    },
  });
  const missingContractsDir = join(cwd, "does-not-exist");

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    missingContractsDir,
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /契约规格有问题/);

  const records = runRecords(cwd);
  const parent = records.find((record) => record.kind === "series");
  assert.equal(parent?.task?.seriesId, "missing-contracts-series");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.outcome, "error");
  assert.match(String(parent?.errorReason), /契约规格有问题/);
  assert.equal(records.some((record) => record.kind === "series-task"), false);
});

test("CLI run without task errors when config has no task series", () => {
  const { cwd, contractsDir } = projectFixture({ config: {} });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法: harness run "<task 描述>"/);
  assert.match(result.stderr, /或在 harness\.config\.json 配置 tasks/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Contract } from "../src/types.js";
import {
  decideTaskResume,
  loadTaskSeriesConfig,
  readSeriesLedger,
  seriesLedgerPath,
  selectTaskContracts,
  taskHash,
  writeSeriesLedger,
} from "../src/harness/series.js";
import type {
  AutoCommitConfig,
  SeriesLedger,
  TaskDefaults,
  TaskSeriesTask,
} from "../src/harness/series.js";

const contracts: Contract[] = [
  { id: "smoke.boot", type: "command", cmd: "true" },
  { id: "domain.model-boundary", type: "command", stage: "domain", cmd: "true" },
  { id: "service.split", type: "command", stage: "service-refactor", cmd: "true" },
  { id: "service.smoke", type: "command", stage: "service-refactor", cmd: "true" },
];

// @ts-expect-error taskHash must require defaults and not be assignable to a two-arg function
const unsafeTaskHash: (task: TaskSeriesTask, autoCommit: AutoCommitConfig) => string = taskHash;
void unsafeTaskHash;
const safeTaskHash: (
  task: TaskSeriesTask,
  autoCommit: AutoCommitConfig,
  defaults: TaskDefaults,
) => string = taskHash;
void safeTaskHash;

test("series config parses defaults, tasks, and auto commit settings", () => {
  const config = loadTaskSeriesConfig({
    series: { id: "order-refactor" },
    taskDefaults: { gate: { contracts: ["smoke.boot"] } },
    autoCommit: { enabled: true, messageTemplate: "harness: {id}" },
    tasks: [
      {
        id: "extract-domain-model",
        task: "Extract the order domain model.",
        gate: { contracts: ["domain.model-boundary"] },
      },
    ],
  });

  assert.equal(config?.seriesId, "order-refactor");
  assert.equal(config?.autoCommit.enabled, true);
  assert.equal(config?.autoCommit.messageTemplate, "harness: {id}");
  assert.deepEqual(config?.taskDefaults.gate?.contracts, ["smoke.boot"]);
  assert.equal(config?.tasks[0]?.id, "extract-domain-model");
});

test("series config allows legacy root fields alongside tasks", () => {
  const config = loadTaskSeriesConfig({
    baseline: ["smoke.boot"],
    rules: [{ when: ["src/**"], select: ["domain.model-boundary"] }],
    sandbox: { mode: "workspace-write" },
    tasks: [{ id: "compat", task: "Keep legacy root fields working." }],
  });

  assert.equal(config?.seriesId, "default");
  assert.equal(config?.tasks[0]?.id, "compat");
});

test("series config returns undefined when tasks are absent", () => {
  assert.equal(loadTaskSeriesConfig({ baseline: ["smoke.boot"] }), undefined);
});

test("series config rejects duplicate task ids and unknown task fields", () => {
  assert.throws(
    () => loadTaskSeriesConfig({
      tasks: [
        { id: "same", task: "one" },
        { id: "same", task: "two" },
      ],
    }),
    /重复 task id: same/,
  );

  assert.throws(
    () => loadTaskSeriesConfig({
      tasks: [{ id: "one", task: "one", extra: true }],
    }),
    /未知 tasks 字段: extra/,
  );
});

test("series config rejects invalid ids and commit templates", () => {
  assert.throws(
    () => loadTaskSeriesConfig({
      series: { id: "../bad" },
      tasks: [{ id: "one", task: "one" }],
    }),
    /series.id/,
  );

  assert.throws(
    () => loadTaskSeriesConfig({
      autoCommit: { messageTemplate: "harness: {branch}" },
      tasks: [{ id: "one", task: "one" }],
    }),
    /未知 commit message placeholder: branch/,
  );
});

test("series config rejects unknown nested fields in owned objects", () => {
  assert.throws(
    () => loadTaskSeriesConfig({
      series: { id: "ok", extra: true },
      tasks: [{ id: "one", task: "one" }],
    }),
    /未知 series 字段: extra/,
  );

  assert.throws(
    () => loadTaskSeriesConfig({
      taskDefaults: { gate: { contracts: ["smoke.boot"], extra: true } },
      tasks: [{ id: "one", task: "one" }],
    }),
    /未知 taskDefaults\.gate 字段: extra/,
  );

  assert.throws(
    () => loadTaskSeriesConfig({
      autoCommit: { enabled: true, extra: true },
      tasks: [{ id: "one", task: "one" }],
    }),
    /未知 autoCommit 字段: extra/,
  );

  assert.throws(
    () => loadTaskSeriesConfig({
      tasks: [{ id: "one", task: "one", gate: { stage: "domain", extra: true } }],
    }),
    /未知 tasks\.one\.gate 字段: extra/,
  );
});

test("task gate selection merges defaults, explicit contracts, and stage contracts", () => {
  const config = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["smoke.boot"] } },
    tasks: [
      {
        id: "split-services",
        task: "Split services.",
        gate: {
          contracts: ["domain.model-boundary"],
          stage: "service-refactor",
        },
      },
    ],
  })!;

  const selected = selectTaskContracts({
    contracts,
    task: config.tasks[0]!,
    defaults: config.taskDefaults,
  });

  assert.deepEqual(
    selected.map((contract) => contract.id),
    ["smoke.boot", "domain.model-boundary", "service.split", "service.smoke"],
  );
});

test("task gate selection fails closed on missing explicit contracts and empty selectors", () => {
  const missing = loadTaskSeriesConfig({
    tasks: [{ id: "missing", task: "Missing.", gate: { contracts: ["nope"] } }],
  })!;

  assert.throws(
    () => selectTaskContracts({
      contracts,
      task: missing.tasks[0]!,
      defaults: missing.taskDefaults,
    }),
    /未知契约: nope/,
  );

  const emptyStage = loadTaskSeriesConfig({
    tasks: [{ id: "empty", task: "Empty.", gate: { stage: "none" } }],
  })!;

  assert.throws(
    () => selectTaskContracts({
      contracts,
      task: emptyStage.tasks[0]!,
      defaults: emptyStage.taskDefaults,
    }),
    /未选择任何契约/,
  );
});

test("task gate selection falls back to CLI stage or all contracts", () => {
  const config = loadTaskSeriesConfig({
    tasks: [{ id: "fallback", task: "Fallback." }],
  })!;

  assert.deepEqual(
    selectTaskContracts({
      contracts,
      task: config.tasks[0]!,
      defaults: config.taskDefaults,
      fallbackStage: "domain",
    }).map((contract) => contract.id),
    ["domain.model-boundary"],
  );

  assert.deepEqual(
    selectTaskContracts({
      contracts,
      task: config.tasks[0]!,
      defaults: config.taskDefaults,
    }).map((contract) => contract.id),
    contracts.map((contract) => contract.id),
  );
});

test("taskHash changes when prompt, gate, or commit settings change", () => {
  const base = loadTaskSeriesConfig({
    autoCommit: { messageTemplate: "harness: {id}" },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["smoke.boot"] } }],
  })!;
  const changedPrompt = loadTaskSeriesConfig({
    autoCommit: { messageTemplate: "harness: {id}" },
    tasks: [{ id: "one", task: "two", gate: { contracts: ["smoke.boot"] } }],
  })!;
  const changedGate = loadTaskSeriesConfig({
    autoCommit: { messageTemplate: "harness: {id}" },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["domain.model-boundary"] } }],
  })!;
  const changedCommit = loadTaskSeriesConfig({
    autoCommit: { messageTemplate: "harness task {id}" },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["smoke.boot"] } }],
  })!;

  const baseHash = taskHash(base.tasks[0]!, base.autoCommit, base.taskDefaults);
  assert.notEqual(
    baseHash,
    taskHash(changedPrompt.tasks[0]!, changedPrompt.autoCommit, changedPrompt.taskDefaults),
  );
  assert.notEqual(
    baseHash,
    taskHash(changedGate.tasks[0]!, changedGate.autoCommit, changedGate.taskDefaults),
  );
  assert.notEqual(
    baseHash,
    taskHash(changedCommit.tasks[0]!, changedCommit.autoCommit, changedCommit.taskDefaults),
  );
});

test("taskHash changes when taskDefaults gate changes", () => {
  const base = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["smoke.boot"] } },
    tasks: [{ id: "one", task: "one" }],
  })!;
  const changed = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["domain.model-boundary"] } },
    tasks: [{ id: "one", task: "one" }],
  })!;

  assert.notEqual(
    taskHash(base.tasks[0]!, base.autoCommit, base.taskDefaults),
    taskHash(changed.tasks[0]!, changed.autoCommit, changed.taskDefaults),
  );
});

test("taskHash changes when taskDefaults gate stage changes", () => {
  const base = loadTaskSeriesConfig({
    taskDefaults: { gate: { stage: "domain" } },
    tasks: [{ id: "one", task: "one" }],
  })!;
  const changed = loadTaskSeriesConfig({
    taskDefaults: { gate: { stage: "service-refactor" } },
    tasks: [{ id: "one", task: "one" }],
  })!;

  assert.notEqual(
    taskHash(base.tasks[0]!, base.autoCommit, base.taskDefaults),
    taskHash(changed.tasks[0]!, changed.autoCommit, changed.taskDefaults),
  );
});

test("taskHash changes when merged selector from defaults and task gate changes", () => {
  const base = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["smoke.boot"], stage: "domain" } },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["domain.model-boundary"] } }],
  })!;
  const changedDefaults = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["service.split"], stage: "domain" } },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["domain.model-boundary"] } }],
  })!;
  const changedTaskGate = loadTaskSeriesConfig({
    taskDefaults: { gate: { contracts: ["smoke.boot"], stage: "domain" } },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["service.smoke"] } }],
  })!;

  const baseHash = taskHash(base.tasks[0]!, base.autoCommit, base.taskDefaults);
  assert.notEqual(
    baseHash,
    taskHash(
      changedDefaults.tasks[0]!,
      changedDefaults.autoCommit,
      changedDefaults.taskDefaults,
    ),
  );
  assert.notEqual(
    baseHash,
    taskHash(
      changedTaskGate.tasks[0]!,
      changedTaskGate.autoCommit,
      changedTaskGate.taskDefaults,
    ),
  );
});

test("series ledger path is scoped by safe series id", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));

  assert.equal(
    seriesLedgerPath(cwd, "order-refactor"),
    join(cwd, ".harness", "series", "order-refactor.json"),
  );
});

test("series ledger writes atomically readable JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const ledger: SeriesLedger = {
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "running",
    configHash: "a".repeat(64),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    tasks: [],
  };

  const path = writeSeriesLedger(cwd, ledger);

  assert.equal(path, seriesLedgerPath(cwd, "order-refactor"));
  assert.equal(existsSync(path), true);
  assert.deepEqual(readSeriesLedger(cwd, "order-refactor"), ledger);
});

test("series ledger rejects malformed existing JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const path = seriesLedgerPath(cwd, "order-refactor");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ invalid", "utf8");

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    /series ledger JSON 无效/,
  );
});

test("series ledger rejects ready_to_commit without changedFiles", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const path = seriesLedgerPath(cwd, "order-refactor");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "running",
    configHash: "a".repeat(64),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    tasks: [{
      id: "one",
      taskHash: "b".repeat(64),
      status: "ready_to_commit",
      runRecord: ".harness/runs/one.json",
    }],
  }), "utf8");

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /series ledger changedFiles 无效/);
      assert.doesNotMatch(error.message, /series ledger JSON 无效/);
      return true;
    },
  );
});

test("series ledger rejects completed task without completedAt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const path = seriesLedgerPath(cwd, "order-refactor");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "completed",
    configHash: "a".repeat(64),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    tasks: [{
      id: "one",
      taskHash: "b".repeat(64),
      status: "completed",
    }],
  }), "utf8");

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /series ledger completedAt 无效/);
      assert.doesNotMatch(error.message, /series ledger JSON 无效/);
      return true;
    },
  );
});

test("series ledger keeps filesystem read failures distinct from JSON parse failures", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const path = seriesLedgerPath(cwd, "order-refactor");
  mkdirSync(path, { recursive: true });

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /series ledger JSON 无效/);
      return true;
    },
  );
});

test("series ledger write rejects invalid ledger objects from JS callers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));

  assert.throws(
    () => writeSeriesLedger(cwd, {
      schemaVersion: 1,
      seriesId: "order-refactor",
      status: "running",
      configHash: "a".repeat(64),
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
      tasks: [{
        id: "bad/id",
        taskHash: "b".repeat(64),
        status: "pending",
      }],
    } as SeriesLedger),
    /安全路径片段/,
  );
});

test("series ledger write uses unique temp files and leaves no tmp artifacts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const ledger: SeriesLedger = {
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "running",
    configHash: "a".repeat(64),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:01.000Z",
    tasks: [],
  };

  writeSeriesLedger(cwd, ledger);
  writeSeriesLedger(cwd, { ...ledger, updatedAt: "2026-06-17T00:00:02.000Z" });

  assert.deepEqual(
    readdirSync(dirname(seriesLedgerPath(cwd, "order-refactor"))).filter((entry) =>
      entry.endsWith(".tmp")
    ),
    [],
  );
});

test("decideTaskResume skips completed matching task and stops on hash drift", () => {
  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "completed",
        commit: "abc123",
      },
    }),
    { action: "skip" },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-b",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "completed",
        commit: "abc123",
      },
    }),
    {
      action: "stop",
      reason: "task one 已完成但配置已变化",
    },
  );
});

test("decideTaskResume resumes ready_to_commit and reruns only pending or running tasks", () => {
  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "ready_to_commit",
        changedFiles: ["src/a.ts"],
      },
    }),
    { action: "commit" },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-b",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "ready_to_commit",
        changedFiles: ["src/a.ts"],
        runRecord: ".harness/runs/one.json",
      },
    }),
    {
      action: "stop",
      reason: "task one 已处于 ready_to_commit 状态，但当前配置与已发布文件不一致",
    },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "pending",
      },
    }),
    { action: "run" },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "running",
      },
    }),
    { action: "run" },
  );
});

test("decideTaskResume stops terminal non-success states for manual handling", () => {
  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "blocked",
        errorReason: "needs review",
      },
    }),
    {
      action: "stop",
      reason: "task one 已处于 blocked 状态，需人工处理后再继续",
    },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "escalated",
        runRecord: ".harness/runs/one.json",
      },
    }),
    {
      action: "stop",
      reason: "task one 已处于 escalated 状态，需人工处理后再继续",
    },
  );

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "hash-a",
      ledgerTask: {
        id: "one",
        taskHash: "hash-a",
        status: "error",
        errorReason: "boom",
      },
    }),
    {
      action: "stop",
      reason: "task one 已处于 error 状态，需人工处理后再继续",
    },
  );
});

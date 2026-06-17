import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Contract } from "../src/types.js";
import {
  commitPublishedChanges,
  decideTaskResume,
  ensureCleanGitWorktree,
  loadTaskSeriesConfig,
  readSeriesLedger,
  renderCommitMessage,
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

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit ${result.status ?? "null"}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
  return result.stdout.trim();
}

function gitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-git-"));
  runGit(["init"], cwd);
  runGit(["config", "user.name", "Harness Tests"], cwd);
  runGit(["config", "user.email", "harness-tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# harness\n", "utf8");
  runGit(["add", "README.md"], cwd);
  runGit(["commit", "-m", "chore: init"], cwd);
  return cwd;
}

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

test("series ledger rejects duplicate task ids", () => {
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
    tasks: [
      {
        id: "one",
        taskHash: "b".repeat(64),
        status: "pending",
      },
      {
        id: "one",
        taskHash: "c".repeat(64),
        status: "running",
      },
    ],
  }), "utf8");

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    /重复 series ledger task id: one/,
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

test("series ledger write rejects duplicate task ids from JS callers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));

  assert.throws(
    () => writeSeriesLedger(cwd, {
      schemaVersion: 1,
      seriesId: "order-refactor",
      status: "running",
      configHash: "a".repeat(64),
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
      tasks: [
        {
          id: "one",
          taskHash: "b".repeat(64),
          status: "pending",
        },
        {
          id: "one",
          taskHash: "c".repeat(64),
          status: "running",
        },
      ],
    } as SeriesLedger),
    /重复 series ledger task id: one/,
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
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-ledger-"));
  const ledger: SeriesLedger = {
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "running",
    configHash: "a".repeat(64),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    tasks: [
      {
        id: "one",
        taskHash: "a".repeat(64),
        status: "ready_to_commit",
        changedFiles: ["src/a.ts"],
        runRecord: ".harness/runs/one.json",
      },
    ],
  };
  writeSeriesLedger(cwd, ledger);
  const persistedReadyToCommit = readSeriesLedger(cwd, "order-refactor")?.tasks[0];

  assert.deepEqual(
    decideTaskResume({
      taskId: "one",
      taskHash: "a".repeat(64),
      ledgerTask: persistedReadyToCommit,
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

test("renderCommitMessage expands supported placeholders and trailers", () => {
  assert.equal(
    renderCommitMessage({
      template: "task {index}/{total}: {id}",
      taskId: "extract-domain",
      seriesId: "order-refactor",
      taskIndex: 2,
      taskCount: 5,
    }),
    [
      "task 2/5: extract-domain",
      "",
      "Harness-Task-Id: extract-domain",
      "Harness-Series-Id: order-refactor",
    ].join("\n"),
  );
});

test("ensureCleanGitWorktree ignores .harness runtime state but rejects source changes", () => {
  const cwd = gitRepo();

  mkdirSync(join(cwd, ".harness", "runs"), { recursive: true });
  writeFileSync(join(cwd, ".harness", "runs", "task.json"), "{\"ok\":true}\n", "utf8");
  assert.doesNotThrow(() => ensureCleanGitWorktree(cwd));

  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "task.ts"), "export const task = true;\n", "utf8");

  assert.throws(
    () => ensureCleanGitWorktree(cwd),
    /工作区存在未提交变更: src\/task\.ts/,
  );
});

test("ensureCleanGitWorktree reports source renames and ignores .harness-only renames", () => {
  const cwd = gitRepo();

  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".harness"), { recursive: true });
  writeFileSync(join(cwd, "src", "old.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "old.json"), "{\"version\":1}\n", "utf8");
  runGit(["add", "src/old.ts", ".harness/old.json"], cwd);
  runGit(["commit", "-m", "chore: add rename fixtures"], cwd);

  runGit(["mv", "src/old.ts", "src/new.ts"], cwd);
  runGit(["mv", ".harness/old.json", ".harness/new.json"], cwd);

  assert.throws(
    () => ensureCleanGitWorktree(cwd),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /src\/old\.ts/);
      assert.match(error.message, /src\/new\.ts/);
      assert.doesNotMatch(error.message, /\.harness\/old\.json/);
      assert.doesNotMatch(error.message, /\.harness\/new\.json/);
      return true;
    },
  );
});

test("commitPublishedChanges stages only published files and excludes .harness", () => {
  const cwd = gitRepo();

  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".harness"), { recursive: true });
  writeFileSync(join(cwd, "src", "task.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":1}\n", "utf8");
  runGit(["add", "src/task.ts", ".harness/tracked.json"], cwd);
  runGit(["commit", "-m", "chore: add tracked files"], cwd);

  writeFileSync(join(cwd, "src", "task.ts"), "export const value = 2;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":2}\n", "utf8");
  writeFileSync(join(cwd, ".harness", "runtime.log"), "runtime\n", "utf8");

  const result = commitPublishedChanges({
    cwd,
    changedFiles: ["src/task.ts", ".harness/tracked.json", ".harness/runtime.log"],
    message: "feat: publish task",
  });

  assert.deepEqual(result.committed, true);
  assert.match(result.commit ?? "", /^[a-f0-9]{40}$/);
  assert.deepEqual(
    runGit(["show", "--pretty=format:", "--name-only", "HEAD"], cwd)
      .split("\n")
      .filter(Boolean),
    ["src/task.ts"],
  );
  const status = runGit(["status", "--short"], cwd);
  assert.match(status, /^M \.harness\/tracked\.json$/m);
  assert.doesNotMatch(status, /src\/task\.ts/);
});

test("commitPublishedChanges reports no commit when no published files changed", () => {
  const cwd = gitRepo();

  mkdirSync(join(cwd, ".harness"), { recursive: true });
  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":1}\n", "utf8");
  runGit(["add", ".harness/tracked.json"], cwd);
  runGit(["commit", "-m", "chore: add harness file"], cwd);
  const before = runGit(["rev-parse", "HEAD"], cwd);

  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":2}\n", "utf8");

  assert.deepEqual(
    commitPublishedChanges({
      cwd,
      changedFiles: [".harness/tracked.json"],
      message: "feat: publish task",
    }),
    { committed: false },
  );
  assert.equal(runGit(["rev-parse", "HEAD"], cwd), before);
  assert.match(runGit(["status", "--short"], cwd), /^M \.harness\/tracked\.json$/m);
});

test("commitPublishedChanges rejects unsafe changedFiles paths", () => {
  const cwd = gitRepo();

  assert.throws(
    () => commitPublishedChanges({
      cwd,
      changedFiles: ["/tmp/absolute.ts"],
      message: "feat: publish task",
    }),
    /changedFiles 路径无效: \/tmp\/absolute\.ts/,
  );
  assert.throws(
    () => commitPublishedChanges({
      cwd,
      changedFiles: ["../escape.ts"],
      message: "feat: publish task",
    }),
    /changedFiles 路径无效: \.\.\/escape\.ts/,
  );
});

test("commitPublishedChanges ignores tracked .harness changes when mixed with straightforward published paths", () => {
  const cwd = gitRepo();

  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".harness"), { recursive: true });
  writeFileSync(join(cwd, "src", "task.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":1}\n", "utf8");
  runGit(["add", "src/task.ts", ".harness/tracked.json"], cwd);
  runGit(["commit", "-m", "chore: add tracked files"], cwd);

  writeFileSync(join(cwd, "src", "task.ts"), "export const value = 2;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "tracked.json"), "{\"version\":2}\n", "utf8");

  commitPublishedChanges({
    cwd,
    changedFiles: [".harness/tracked.json", "src/task.ts"],
    message: "feat: publish task",
  });

  assert.deepEqual(
    runGit(["show", "--pretty=format:", "--name-only", "HEAD"], cwd)
      .split("\n")
      .filter(Boolean),
    ["src/task.ts"],
  );
  assert.match(runGit(["status", "--short"], cwd), /^M \.harness\/tracked\.json$/m);
});

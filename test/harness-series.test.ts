import { test } from "node:test";
import assert from "node:assert/strict";

import type { Contract } from "../src/types.js";
import {
  loadTaskSeriesConfig,
  selectTaskContracts,
  taskHash,
} from "../src/harness/series.js";

const contracts: Contract[] = [
  { id: "smoke.boot", type: "command", cmd: "true" },
  { id: "domain.model-boundary", type: "command", stage: "domain", cmd: "true" },
  { id: "service.split", type: "command", stage: "service-refactor", cmd: "true" },
  { id: "service.smoke", type: "command", stage: "service-refactor", cmd: "true" },
];

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

  const baseHash = taskHash(base.tasks[0]!, base.autoCommit);
  assert.notEqual(baseHash, taskHash(changedPrompt.tasks[0]!, changedPrompt.autoCommit));
  assert.notEqual(baseHash, taskHash(changedGate.tasks[0]!, changedGate.autoCommit));
  assert.notEqual(baseHash, taskHash(changedCommit.tasks[0]!, changedCommit.autoCommit));
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

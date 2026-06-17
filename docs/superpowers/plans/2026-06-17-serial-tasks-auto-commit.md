# Serial Tasks Auto Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add config-driven serial task execution to `harness run`, with per-task gate selection, resumable progress state, automatic per-task git commits, and git initialization during `harness create`.

**Architecture:** Keep the existing single-task `runLoop` as the inner agent/gate/publish loop, and add a host-side serial orchestrator in `src/harness/series.ts`. The orchestrator parses `harness.config.json`, selects contracts per task, persists `.harness/series/<series-id>.json`, commits only gate-published files, and invokes a fresh run environment per task through CLI-provided callbacks.

**Tech Stack:** TypeScript ESM, Node.js built-in `node:test`, `node:fs`, `node:child_process`, existing `GateCore`, `RunEnvironment`, `RunRecorder`, `PublicationResult`, and git CLI subprocesses.

---

## File Structure

- Modify `src/harness/run.ts`
  - Add `publication?: PublicationResult` to `RunOutcome`.
  - Populate it only when `environment.publish()` succeeds.
  - Keep all existing outcome strings and exit semantics unchanged.

- Modify `test/harness-run.test.ts`
  - Add RED coverage proving `runLoop()` returns the successful publication result.

- Modify `src/harness/scaffold.ts`
  - Ensure the target directory exists before file writes.
  - Detect whether the target is already inside a git worktree.
  - Run `git init <target>` only outside a worktree.
  - Extend `CreateResult` with `git: "initialized" | "existing"`.

- Modify `test/scaffold.test.ts`
  - Add RED coverage for git initialization outside a repo.
  - Add RED coverage that `createProject()` does not create nested `.git` inside an existing repo.

- Create `src/harness/series.ts`
  - Define task series config types and validation.
  - Select task-specific contracts.
  - Compute stable task hashes.
  - Read and atomically write series ledgers.
  - Decide whether to skip, resume commit, rerun, or stop.
  - Provide git helpers for clean-state checks and task commits.
  - Provide `runTaskSeries()` host orchestrator with dependency injection for tests and CLI integration.

- Create `test/harness-series.test.ts`
  - Cover config parsing, gate selection, task hashing, ledger decisions, git commit helpers, and injected serial orchestration behavior without Daytona.

- Modify `src/cli.ts`
  - Refactor single-task run into a reusable `runSingleTask()` function that returns `RunOutcome`, run record path, environment name, and publication.
  - Route `harness run` without a task into serial mode when config has `tasks`.
  - Keep explicit task mode unchanged.
  - Print series progress and exit with the failed task outcome.

- Modify `src/index.ts`
  - Export the new public series types and helpers that are useful for tests and programmatic use.

- Create `test/cli-series.test.ts`
  - Cover explicit task compatibility.
  - Cover no-position `harness run` consuming configured tasks.
  - Cover no-position `harness run` without configured tasks returning a usage error.

- Modify `docs/usage.md`
  - Document `tasks`, `taskDefaults.gate`, `autoCommit`, progress ledger, and resume rules.

- Modify `README.md`
  - Add a short serial-run example and point to `docs/usage.md`.

---

## Task 1: Expose Successful Publication From `runLoop`

**Files:**
- Modify: `src/harness/run.ts`
- Test: `test/harness-run.test.ts`

- [ ] **Step 1: Add the failing publication-result test**

Append this test after the existing publication-conflict test in `test/harness-run.test.ts`:

```typescript
test("runLoop: returns the successful publication result", async () => {
  const published = {
    ok: true,
    changedFiles: ["src/order.ts", "test/generated/order.test.ts"],
  };
  const environment: RunEnvironment = {
    name: "publication-success",
    async runTask() {
      return { summary: "done", changedFiles: [] };
    },
    async runGate({ contracts, gate, ctx }) {
      return gate.run(contracts, ctx);
    },
    async publish() {
      return published;
    },
    async close() {},
  };

  const out = await runLoop({
    task: "t",
    contracts: [{ id: "c1", type: "flaky" }],
    gate: new GateCore().use(flakyPlugin({ fixed: true })),
    ctx,
    environment,
    budget: budget(),
  });

  assert.equal(out.outcome, "ready_for_mr");
  assert.deepEqual(out.publication, published);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/harness-run.test.js --test-name-pattern "returns the successful publication result"
```

Expected: TypeScript build fails with a message like:

```text
Property 'publication' does not exist on type 'RunOutcome'
```

- [ ] **Step 3: Add the minimal `RunOutcome.publication` field**

In `src/harness/run.ts`, change `RunOutcome` to:

```typescript
export interface RunOutcome {
  outcome: "ready_for_mr" | "escalated" | "blocked";
  attempts: number;
  report: GateReport;
  action?: Exclude<EscalationAction, { kind: "continue" }>;
  publication?: PublicationResult;
  logs: string[];
}
```

Then change the successful pass return from:

```typescript
return { outcome: "ready_for_mr", attempts: state.attempts, report, logs };
```

to:

```typescript
return {
  outcome: "ready_for_mr",
  attempts: state.attempts,
  report,
  publication,
  logs,
};
```

Do not add `publication` to blocked or escalated outcomes.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run build && node --test dist/test/harness-run.test.js --test-name-pattern "returns the successful publication result"
```

Expected: the focused test passes.

- [ ] **Step 5: Run the existing run-loop tests**

Run:

```bash
npm run build && node --test dist/test/harness-run.test.js
```

Expected: all `harness-run` tests pass.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/harness/run.ts test/harness-run.test.ts
git commit -m "feat: expose run publication result"
```

---

## Task 2: Initialize Git During `harness create`

**Files:**
- Modify: `src/harness/scaffold.ts`
- Modify: `test/scaffold.test.ts`

- [ ] **Step 1: Add RED tests for git initialization**

Replace the imports at the top of `test/scaffold.test.ts` with:

```typescript
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createProject } from "../src/harness/scaffold.js";
```

Append these tests:

```typescript
function git(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result;
}

test("create initializes git when target is not inside a repository", () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-create-git-"));
  const target = join(parent, "project");

  const result = createProject(target);

  assert.equal(result.git, "initialized");
  assert.equal(existsSync(join(target, ".git")), true);
});

test("create does not initialize a nested git repository inside an existing worktree", () => {
  const repo = mkdtempSync(join(tmpdir(), "harness-create-existing-git-"));
  git(["init"], repo);
  mkdirSync(join(repo, "nested"));

  const result = createProject(join(repo, "nested"));

  assert.equal(result.git, "existing");
  assert.equal(existsSync(join(repo, "nested", ".git")), false);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/scaffold.test.js --test-name-pattern "create initializes git|create does not initialize"
```

Expected: TypeScript build fails with:

```text
Property 'git' does not exist on type 'CreateResult'
```

- [ ] **Step 3: Implement git detection and initialization**

In `src/harness/scaffold.ts`, change the imports to:

```typescript
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
```

Change `CreateResult` to:

```typescript
export interface CreateResult {
  created: string[];
  skipped: string[];
  git: "initialized" | "existing";
}
```

Add these helpers above `createProject()`:

```typescript
function isInsideGitWorktree(targetDir: string): boolean {
  const result = spawnSync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    {
      cwd: targetDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function initializeGit(targetDir: string): "initialized" | "existing" {
  mkdirSync(targetDir, { recursive: true });
  if (isInsideGitWorktree(targetDir)) return "existing";

  const result = spawnSync("git", ["init", targetDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git init failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
  return "initialized";
}
```

Change `createProject()` to initialize git before writing files:

```typescript
export function createProject(targetDir: string, force = false): CreateResult {
  const git = initializeGit(targetDir);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of projectFiles()) {
    const full = join(targetDir, f.path);
    if (existsSync(full) && !force) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, f.content, "utf8");
    created.push(f.path);
  }
  return { created, skipped, git };
}
```

- [ ] **Step 4: Update CLI output for git status**

In `src/cli.ts`, change `cmdCreate()` from:

```typescript
const { created, skipped } = createProject(target, values.force as boolean);
console.log(`✓ 初始化 harness 项目于 ${target}`);
```

to:

```typescript
const { created, skipped, git } = createProject(target, values.force as boolean);
console.log(`✓ 初始化 harness 项目于 ${target}`);
console.log(`  git: ${git === "initialized" ? "initialized" : "existing repository"}`);
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run build && node --test dist/test/scaffold.test.js
```

Expected: all scaffold tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/harness/scaffold.ts src/cli.ts test/scaffold.test.ts
git commit -m "feat: initialize git during create"
```

---

## Task 3: Parse Task Series Config And Select Per-task Gates

**Files:**
- Create: `src/harness/series.ts`
- Create: `test/harness-series.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add RED config and gate-selection tests**

Create `test/harness-series.test.ts`:

```typescript
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
  const changed = loadTaskSeriesConfig({
    autoCommit: { messageTemplate: "harness task {id}" },
    tasks: [{ id: "one", task: "one", gate: { contracts: ["smoke.boot"] } }],
  })!;

  assert.notEqual(
    taskHash(base.tasks[0]!, base.autoCommit),
    taskHash(changed.tasks[0]!, changed.autoCommit),
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "series config"
```

Expected: TypeScript build fails because `src/harness/series.ts` does not exist.

- [ ] **Step 3: Create `src/harness/series.ts` config parser and selector**

Create `src/harness/series.ts` with this initial implementation:

```typescript
import { createHash } from "node:crypto";

import { selectByStage } from "../selector.js";
import type { Contract } from "../types.js";

const SERIES_FIELDS = new Set(["id"]);
const ROOT_FIELDS = new Set([
  "series",
  "taskDefaults",
  "autoCommit",
  "tasks",
]);
const TASK_DEFAULTS_FIELDS = new Set(["gate"]);
const AUTO_COMMIT_FIELDS = new Set(["enabled", "messageTemplate"]);
const TASK_FIELDS = new Set(["id", "task", "gate", "commitMessage"]);
const GATE_FIELDS = new Set(["contracts", "stage"]);
const MESSAGE_PLACEHOLDERS = new Set(["id", "index", "total"]);

export interface TaskGateSelector {
  contracts?: string[];
  stage?: string;
}

export interface TaskDefaults {
  gate?: TaskGateSelector;
}

export interface AutoCommitConfig {
  enabled: boolean;
  messageTemplate: string;
}

export interface TaskSeriesTask {
  id: string;
  task: string;
  gate?: TaskGateSelector;
  commitMessage?: string;
}

export interface TaskSeriesConfig {
  seriesId: string;
  taskDefaults: TaskDefaults;
  autoCommit: AutoCommitConfig;
  tasks: TaskSeriesTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  known: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`未知 ${label} 字段: ${key}`);
  }
}

function assertSafeSegment(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${field} 必须是安全路径片段`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${field} 必须是字符串数组`);
  }
  return [...value];
}

function optionalGate(value: unknown, field: string): TaskGateSelector | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${field} 必须是普通对象`);
  rejectUnknownFields(value, GATE_FIELDS, field);
  const gate: TaskGateSelector = {};
  if (hasOwn(value, "contracts")) {
    gate.contracts = stringArray(value.contracts, `${field}.contracts`);
  }
  if (hasOwn(value, "stage")) {
    if (typeof value.stage !== "string" || value.stage.trim() === "") {
      throw new TypeError(`${field}.stage 必须是非空字符串`);
    }
    gate.stage = value.stage;
  }
  return gate;
}

function validateTemplate(template: string): string {
  for (const match of template.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    if (!MESSAGE_PLACEHOLDERS.has(name)) {
      throw new Error(`未知 commit message placeholder: ${name}`);
    }
  }
  return template;
}

function loadAutoCommit(value: unknown): AutoCommitConfig {
  if (value === undefined) {
    return { enabled: true, messageTemplate: "harness: {id}" };
  }
  if (!isRecord(value)) throw new TypeError("autoCommit 必须是普通对象");
  rejectUnknownFields(value, AUTO_COMMIT_FIELDS, "autoCommit");
  const enabled = hasOwn(value, "enabled") ? value.enabled : true;
  if (typeof enabled !== "boolean") {
    throw new TypeError("autoCommit.enabled 必须是 boolean");
  }
  const messageTemplate = hasOwn(value, "messageTemplate")
    ? value.messageTemplate
    : "harness: {id}";
  if (typeof messageTemplate !== "string" || messageTemplate.trim() === "") {
    throw new TypeError("autoCommit.messageTemplate 必须是非空字符串");
  }
  return { enabled, messageTemplate: validateTemplate(messageTemplate) };
}

function loadTaskDefaults(value: unknown): TaskDefaults {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("taskDefaults 必须是普通对象");
  rejectUnknownFields(value, TASK_DEFAULTS_FIELDS, "taskDefaults");
  const gate = optionalGate(value.gate, "taskDefaults.gate");
  return gate ? { gate } : {};
}

function loadSeriesId(value: unknown): string {
  if (value === undefined) return "default";
  if (!isRecord(value)) throw new TypeError("series 必须是普通对象");
  rejectUnknownFields(value, SERIES_FIELDS, "series");
  return hasOwn(value, "id") ? assertSafeSegment(value.id, "series.id") : "default";
}

function loadTask(value: unknown, ids: Set<string>): TaskSeriesTask {
  if (!isRecord(value)) throw new TypeError("tasks 项必须是普通对象");
  rejectUnknownFields(value, TASK_FIELDS, "tasks");
  const id = assertSafeSegment(value.id, "tasks.id");
  if (ids.has(id)) throw new Error(`重复 task id: ${id}`);
  ids.add(id);
  if (typeof value.task !== "string" || value.task.trim() === "") {
    throw new TypeError(`tasks.${id}.task 必须是非空字符串`);
  }
  const gate = optionalGate(value.gate, `tasks.${id}.gate`);
  const commitMessage = value.commitMessage;
  if (
    commitMessage !== undefined &&
    (typeof commitMessage !== "string" || commitMessage.trim() === "")
  ) {
    throw new TypeError(`tasks.${id}.commitMessage 必须是非空字符串`);
  }
  return {
    id,
    task: value.task,
    ...(gate ? { gate } : {}),
    ...(typeof commitMessage === "string"
      ? { commitMessage: validateTemplate(commitMessage) }
      : {}),
  };
}

export function loadTaskSeriesConfig(config: unknown): TaskSeriesConfig | undefined {
  if (!isRecord(config)) throw new TypeError("Harness 配置必须是普通对象");
  if (!hasOwn(config, "tasks")) return undefined;
  rejectUnknownFields(
    Object.fromEntries(
      Object.entries(config).filter(([key]) => ROOT_FIELDS.has(key)),
    ),
    ROOT_FIELDS,
    "series root",
  );
  const rawTasks = config.tasks;
  if (!Array.isArray(rawTasks)) throw new TypeError("tasks 必须是数组");
  if (rawTasks.length === 0) throw new Error("tasks 必须是非空数组");
  const ids = new Set<string>();
  return {
    seriesId: loadSeriesId(config.series),
    taskDefaults: loadTaskDefaults(config.taskDefaults),
    autoCommit: loadAutoCommit(config.autoCommit),
    tasks: rawTasks.map((task) => loadTask(task, ids)),
  };
}

function mergeGate(
  defaults: TaskDefaults,
  task: TaskSeriesTask,
): TaskGateSelector | undefined {
  const contracts = [
    ...(defaults.gate?.contracts ?? []),
    ...(task.gate?.contracts ?? []),
  ];
  const stage = task.gate?.stage ?? defaults.gate?.stage;
  if (contracts.length === 0 && !stage) return undefined;
  return {
    ...(contracts.length ? { contracts } : {}),
    ...(stage ? { stage } : {}),
  };
}

export function selectTaskContracts(input: {
  contracts: Contract[];
  task: TaskSeriesTask;
  defaults: TaskDefaults;
  fallbackStage?: string;
}): Contract[] {
  const gate = mergeGate(input.defaults, input.task);
  if (!gate) {
    return input.fallbackStage
      ? selectByStage(input.contracts, input.fallbackStage)
      : [...input.contracts];
  }

  const byId = new Map(input.contracts.map((contract) => [contract.id, contract]));
  const selected = new Map<string, Contract>();
  for (const id of gate.contracts ?? []) {
    const contract = byId.get(id);
    if (!contract) throw new Error(`未知契约: ${id}`);
    selected.set(id, contract);
  }
  if (gate.stage) {
    for (const contract of selectByStage(input.contracts, gate.stage)) {
      selected.set(contract.id, contract);
    }
  }
  const result = [...selected.values()];
  if (result.length === 0) {
    throw new Error(`task ${input.task.id} 未选择任何契约`);
  }
  return result;
}

export function taskHash(
  task: TaskSeriesTask,
  autoCommit: AutoCommitConfig,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      id: task.id,
      task: task.task,
      gate: task.gate ?? null,
      commitMessage: task.commitMessage ?? null,
      autoCommit,
    }))
    .digest("hex");
}
```

- [ ] **Step 4: Export series APIs**

In `src/index.ts`, add:

```typescript
export {
  loadTaskSeriesConfig,
  selectTaskContracts,
  taskHash,
  type AutoCommitConfig,
  type TaskDefaults,
  type TaskGateSelector,
  type TaskSeriesConfig,
  type TaskSeriesTask,
} from "./harness/series.js";
```

- [ ] **Step 5: Verify GREEN for parser and selector**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js
```

Expected: all `harness-series` tests pass.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add src/harness/series.ts src/index.ts test/harness-series.test.ts
git commit -m "feat: parse serial task config"
```

---

## Task 4: Persist Series Ledger And Decide Resume Behavior

**Files:**
- Modify: `src/harness/series.ts`
- Modify: `test/harness-series.test.ts`

- [ ] **Step 1: Add RED ledger tests**

Merge these filesystem imports into the top of `test/harness-series.test.ts`:

```typescript
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Merge these names into the existing `../src/harness/series.js` import at the
top of `test/harness-series.test.ts`:

```typescript
import {
  decideTaskResume,
  readSeriesLedger,
  seriesLedgerPath,
  writeSeriesLedger,
  type SeriesLedger,
} from "../src/harness/series.js";
```

Append these tests:

```typescript
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
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ invalid", "utf8");

  assert.throws(
    () => readSeriesLedger(cwd, "order-refactor"),
    /series ledger JSON 无效/,
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

test("decideTaskResume resumes ready_to_commit and reruns incomplete tasks", () => {
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
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "series ledger|decideTaskResume"
```

Expected: TypeScript build fails because ledger types and functions are not exported.

- [ ] **Step 3: Add ledger types and persistence helpers**

In `src/harness/series.ts`, extend imports:

```typescript
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
```

Add these types after `TaskSeriesConfig`:

```typescript
export type SeriesStatus = "running" | "completed" | "error";
export type SeriesTaskStatus =
  | "pending"
  | "running"
  | "ready_to_commit"
  | "completed"
  | "blocked"
  | "escalated"
  | "error";

export interface SeriesLedgerTask {
  id: string;
  taskHash: string;
  status: SeriesTaskStatus;
  changedFiles?: string[];
  commit?: string;
  runRecord?: string;
  startedAt?: string;
  completedAt?: string;
  errorReason?: string;
}

export interface SeriesLedger {
  schemaVersion: 1;
  seriesId: string;
  status: SeriesStatus;
  configHash: string;
  createdAt: string;
  updatedAt: string;
  tasks: SeriesLedgerTask[];
}

export type TaskResumeDecision =
  | { action: "skip" }
  | { action: "commit" }
  | { action: "run" }
  | { action: "stop"; reason: string };
```

Add these helpers near `taskHash()`:

```typescript
export function seriesLedgerPath(cwd: string, seriesId: string): string {
  return join(cwd, ".harness", "series", `${assertSafeSegment(seriesId, "series.id")}.json`);
}

function parseLedger(value: unknown, seriesId: string): SeriesLedger {
  if (!isRecord(value)) throw new Error("series ledger 格式无效");
  if (value.schemaVersion !== 1) throw new Error("series ledger schemaVersion 无效");
  if (value.seriesId !== seriesId) throw new Error("series ledger seriesId 不匹配");
  if (value.status !== "running" && value.status !== "completed" && value.status !== "error") {
    throw new Error("series ledger status 无效");
  }
  if (typeof value.configHash !== "string" || !/^[a-f0-9]{64}$/.test(value.configHash)) {
    throw new Error("series ledger configHash 无效");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("series ledger timestamp 无效");
  }
  if (!Array.isArray(value.tasks)) throw new Error("series ledger tasks 无效");
  return value as unknown as SeriesLedger;
}

export function readSeriesLedger(cwd: string, seriesId: string): SeriesLedger | undefined {
  const path = seriesLedgerPath(cwd, seriesId);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `series ledger JSON 无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLedger(parsed, seriesId);
}

export function writeSeriesLedger(cwd: string, ledger: SeriesLedger): string {
  const path = seriesLedgerPath(cwd, ledger.seriesId);
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(ledger, null, 2), "utf8");
  renameSync(temp, path);
  return path;
}

export function configHash(config: TaskSeriesConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}

export function decideTaskResume(input: {
  taskId: string;
  taskHash: string;
  ledgerTask?: SeriesLedgerTask;
}): TaskResumeDecision {
  const existing = input.ledgerTask;
  if (!existing) return { action: "run" };
  if (existing.taskHash !== input.taskHash && existing.status === "completed") {
    return {
      action: "stop",
      reason: `task ${input.taskId} 已完成但配置已变化`,
    };
  }
  if (existing.status === "completed") return { action: "skip" };
  if (
    existing.status === "ready_to_commit" &&
    existing.taskHash === input.taskHash
  ) {
    return { action: "commit" };
  }
  return { action: "run" };
}
```

- [ ] **Step 4: Extend exports**

In `src/index.ts`, extend the series export block with:

```typescript
  configHash,
  decideTaskResume,
  readSeriesLedger,
  seriesLedgerPath,
  writeSeriesLedger,
  type SeriesLedger,
  type SeriesLedgerTask,
  type SeriesStatus,
  type SeriesTaskStatus,
  type TaskResumeDecision,
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "series ledger|decideTaskResume"
```

Expected: focused ledger tests pass.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add src/harness/series.ts src/index.ts test/harness-series.test.ts
git commit -m "feat: persist serial task ledger"
```

---

## Task 5: Add Git Clean-state And Commit Helpers

**Files:**
- Modify: `src/harness/series.ts`
- Modify: `test/harness-series.test.ts`

- [ ] **Step 1: Add RED git helper tests**

Merge this import into the top of `test/harness-series.test.ts`:

```typescript
import { spawnSync } from "node:child_process";
```

Merge these names into the existing `../src/harness/series.js` import at the
top of `test/harness-series.test.ts`:

```typescript
import {
  commitPublishedChanges,
  ensureCleanGitWorktree,
  renderCommitMessage,
} from "../src/harness/series.js";
```

Append the helper and tests:

```typescript

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function gitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-git-"));
  runGit(["init"], cwd);
  runGit(["config", "user.email", "harness@example.test"], cwd);
  runGit(["config", "user.name", "Harness Test"], cwd);
  writeFileSync(join(cwd, "README.md"), "base\n", "utf8");
  runGit(["add", "README.md"], cwd);
  runGit(["commit", "-m", "initial"], cwd);
  return cwd;
}

test("renderCommitMessage expands supported placeholders and trailers", () => {
  assert.equal(
    renderCommitMessage({
      template: "harness: {index}/{total} {id}",
      taskId: "split-services",
      seriesId: "order-refactor",
      index: 2,
      total: 4,
    }),
    [
      "harness: 2/4 split-services",
      "",
      "Harness-Task-Id: split-services",
      "Harness-Series-Id: order-refactor",
    ].join("\n"),
  );
});

test("ensureCleanGitWorktree ignores .harness runtime state but rejects source changes", () => {
  const cwd = gitRepo();
  mkdirSync(join(cwd, ".harness", "series"), { recursive: true });
  writeFileSync(join(cwd, ".harness", "series", "default.json"), "{}", "utf8");

  assert.doesNotThrow(() => ensureCleanGitWorktree(cwd));

  writeFileSync(join(cwd, "src.ts"), "dirty\n", "utf8");
  assert.throws(
    () => ensureCleanGitWorktree(cwd),
    /工作区存在未提交变更: src.ts/,
  );
});

test("commitPublishedChanges stages only published files and excludes .harness", () => {
  const cwd = gitRepo();
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "order.ts"), "export const order = 1;\n", "utf8");
  mkdirSync(join(cwd, ".harness", "runs"), { recursive: true });
  writeFileSync(join(cwd, ".harness", "runs", "run.json"), "{}", "utf8");

  const result = commitPublishedChanges({
    cwd,
    changedFiles: ["src/order.ts", ".harness/runs/run.json"],
    message: renderCommitMessage({
      template: "harness: {id}",
      taskId: "extract-domain-model",
      seriesId: "order-refactor",
      index: 1,
      total: 2,
    }),
  });

  assert.equal(result.committed, true);
  assert.match(result.commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(runGit(["show", "--stat", "--oneline", "--name-only", "HEAD"], cwd), /src\/order\.ts/);
  assert.doesNotMatch(runGit(["show", "--stat", "--oneline", "--name-only", "HEAD"], cwd), /\.harness/);
});

test("commitPublishedChanges reports no commit when no published files changed", () => {
  const cwd = gitRepo();

  const result = commitPublishedChanges({
    cwd,
    changedFiles: [],
    message: renderCommitMessage({
      template: "harness: {id}",
      taskId: "noop",
      seriesId: "order-refactor",
      index: 1,
      total: 1,
    }),
  });

  assert.deepEqual(result, { committed: false });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "CommitMessage|CleanGit|commitPublishedChanges"
```

Expected: TypeScript build fails because git helper functions are not exported.

- [ ] **Step 3: Implement git helpers**

In `src/harness/series.ts`, add imports:

```typescript
import { spawnSync } from "node:child_process";
```

Add these types and helpers:

```typescript
export interface CommitMessageInput {
  template: string;
  taskId: string;
  seriesId: string;
  index: number;
  total: number;
}

export interface CommitPublishedChangesInput {
  cwd: string;
  changedFiles: string[];
  message: string;
}

export type CommitPublishedChangesResult =
  | { committed: true; commit: string }
  | { committed: false };

function runGit(
  cwd: string,
  args: string[],
  input?: string,
): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function isRuntimeHarnessPath(path: string): boolean {
  return path === ".harness" || path.startsWith(".harness/");
}

export function renderCommitMessage(input: CommitMessageInput): string {
  const subject = input.template
    .replaceAll("{id}", input.taskId)
    .replaceAll("{index}", String(input.index))
    .replaceAll("{total}", String(input.total));
  return [
    subject,
    "",
    `Harness-Task-Id: ${input.taskId}`,
    `Harness-Series-Id: ${input.seriesId}`,
  ].join("\n");
}

export function ensureCleanGitWorktree(cwd: string): void {
  runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const status = runGit(cwd, ["status", "--porcelain", "--untracked-files=all"])
    .stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));
  const dirty = status.filter((path) => !isRuntimeHarnessPath(path));
  if (dirty.length > 0) {
    throw new Error(`工作区存在未提交变更: ${dirty.join(", ")}`);
  }
}

export function commitPublishedChanges(
  input: CommitPublishedChangesInput,
): CommitPublishedChangesResult {
  const changedFiles = input.changedFiles.filter((path) => !isRuntimeHarnessPath(path));
  if (changedFiles.length === 0) return { committed: false };

  runGit(input.cwd, ["add", "--", ...changedFiles]);
  const cached = runGit(input.cwd, ["diff", "--cached", "--name-only"])
    .stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (cached.length === 0) return { committed: false };

  runGit(input.cwd, ["commit", "-F", "-"], input.message);
  const commit = runGit(input.cwd, ["rev-parse", "HEAD"]).stdout.trim();
  return { committed: true, commit };
}
```

- [ ] **Step 4: Export git helpers from root**

In `src/index.ts`, extend the series export block with:

```typescript
  commitPublishedChanges,
  ensureCleanGitWorktree,
  renderCommitMessage,
  type CommitMessageInput,
  type CommitPublishedChangesInput,
  type CommitPublishedChangesResult,
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "CommitMessage|CleanGit|commitPublishedChanges"
```

Expected: focused git helper tests pass.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add src/harness/series.ts src/index.ts test/harness-series.test.ts
git commit -m "feat: commit published task changes"
```

---

## Task 6: Add Injected Serial Runner

**Files:**
- Modify: `src/harness/series.ts`
- Modify: `test/harness-series.test.ts`

- [ ] **Step 1: Add RED serial runner tests with injected task execution**

Merge these imports into the top of `test/harness-series.test.ts`:

```typescript
import type { RunOutcome } from "../src/harness/run.js";
import type { GateReport } from "../src/types.js";
```

Merge these names into the existing `../src/harness/series.js` import at the
top of `test/harness-series.test.ts`:

```typescript
import {
  runTaskSeries,
  type SeriesTaskExecutionInput,
} from "../src/harness/series.js";
```

Append these tests:

```typescript
const passReport: GateReport = {
  outcome: "pass",
  results: [],
  summary: { pass: 1, fail: 0, error: 0, needsReview: 0, total: 1 },
  pendingDecisions: [],
  exitCode: 0,
};

function readyOutcome(changedFiles: string[]): RunOutcome {
  return {
    outcome: "ready_for_mr",
    attempts: 1,
    report: passReport,
    publication: { ok: true, changedFiles },
    logs: [],
  };
}

test("runTaskSeries runs tasks in order and records completed ledger entries", async () => {
  const cwd = gitRepo();
  const config = loadTaskSeriesConfig({
    series: { id: "order-refactor" },
    autoCommit: { enabled: false },
    tasks: [
      { id: "one", task: "Task one.", gate: { contracts: ["smoke.boot"] } },
      { id: "two", task: "Task two.", gate: { contracts: ["smoke.boot"] } },
    ],
  })!;
  const seen: string[] = [];
  const selectedContracts: string[][] = [];

  const result = await runTaskSeries({
    cwd,
    config,
    contracts,
    async executeTask(input: SeriesTaskExecutionInput) {
      seen.push(input.task.id);
      selectedContracts.push(input.contracts.map((contract) => contract.id));
      return {
        outcome: readyOutcome([]),
        runRecordPath: `.harness/runs/${input.task.id}.json`,
      };
    },
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(seen, ["one", "two"]);
  assert.deepEqual(selectedContracts, [["smoke.boot"], ["smoke.boot"]]);
  assert.deepEqual(
    readSeriesLedger(cwd, "order-refactor")?.tasks.map((task) => task.status),
    ["completed", "completed"],
  );
});

test("runTaskSeries skips completed matching tasks on resume", async () => {
  const cwd = gitRepo();
  const config = loadTaskSeriesConfig({
    series: { id: "order-refactor" },
    autoCommit: { enabled: false },
    tasks: [
      { id: "one", task: "Task one.", gate: { contracts: ["smoke.boot"] } },
      { id: "two", task: "Task two.", gate: { contracts: ["smoke.boot"] } },
    ],
  })!;
  writeSeriesLedger(cwd, {
    schemaVersion: 1,
    seriesId: "order-refactor",
    status: "running",
    configHash: configHash(config),
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    tasks: [
      {
        id: "one",
        taskHash: taskHash(config.tasks[0]!, config.autoCommit),
        status: "completed",
        completedAt: "2026-06-17T00:00:01.000Z",
      },
    ],
  });
  const seen: string[] = [];

  const result = await runTaskSeries({
    cwd,
    config,
    contracts,
    async executeTask(input) {
      seen.push(input.task.id);
      return {
        outcome: readyOutcome([]),
        runRecordPath: `.harness/runs/${input.task.id}.json`,
      };
    },
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(seen, ["two"]);
});

test("runTaskSeries stops on blocked outcome without running later tasks", async () => {
  const cwd = gitRepo();
  const config = loadTaskSeriesConfig({
    series: { id: "order-refactor" },
    autoCommit: { enabled: false },
    tasks: [
      { id: "one", task: "Task one.", gate: { contracts: ["smoke.boot"] } },
      { id: "two", task: "Task two.", gate: { contracts: ["smoke.boot"] } },
    ],
  })!;
  const seen: string[] = [];

  const result = await runTaskSeries({
    cwd,
    config,
    contracts,
    async executeTask(input) {
      seen.push(input.task.id);
      return {
        outcome: {
          outcome: "blocked",
          attempts: 1,
          report: { ...passReport, outcome: "blocked", exitCode: 2 },
          logs: [],
        },
        runRecordPath: `.harness/runs/${input.task.id}.json`,
      };
    },
  });

  assert.equal(result.outcome, "blocked");
  assert.equal(result.taskId, "one");
  assert.deepEqual(seen, ["one"]);
  assert.equal(readSeriesLedger(cwd, "order-refactor")?.tasks[0]?.status, "blocked");
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "runTaskSeries"
```

Expected: TypeScript build fails because `runTaskSeries` and `SeriesTaskExecutionInput` are missing.

- [ ] **Step 3: Implement injected serial runner**

In `src/harness/series.ts`, import `RunOutcome`:

```typescript
import type { RunOutcome } from "./run.js";
```

Add these types:

```typescript
export interface SeriesTaskExecutionInput {
  task: TaskSeriesTask;
  contracts: Contract[];
  index: number;
  total: number;
}

export interface SeriesTaskExecutionResult {
  outcome: RunOutcome;
  runRecordPath: string;
}

export interface RunTaskSeriesInput {
  cwd: string;
  config: TaskSeriesConfig;
  contracts: Contract[];
  fallbackStage?: string;
  executeTask(input: SeriesTaskExecutionInput): Promise<SeriesTaskExecutionResult>;
}

export type RunTaskSeriesResult =
  | { outcome: "completed" }
  | { outcome: "blocked" | "escalated" | "error"; taskId: string; reason?: string };
```

Add these helpers:

```typescript
function nowIso(): string {
  return new Date().toISOString();
}

function ledgerTask(ledger: SeriesLedger, taskId: string): SeriesLedgerTask | undefined {
  return ledger.tasks.find((task) => task.id === taskId);
}

function upsertLedgerTask(ledger: SeriesLedger, task: SeriesLedgerTask): void {
  const index = ledger.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    ledger.tasks[index] = task;
  } else {
    ledger.tasks.push(task);
  }
  ledger.updatedAt = nowIso();
}

function initialLedger(config: TaskSeriesConfig): SeriesLedger {
  const now = nowIso();
  return {
    schemaVersion: 1,
    seriesId: config.seriesId,
    status: "running",
    configHash: configHash(config),
    createdAt: now,
    updatedAt: now,
    tasks: [],
  };
}
```

Then add:

```typescript
export async function runTaskSeries(
  input: RunTaskSeriesInput,
): Promise<RunTaskSeriesResult> {
  if (input.config.autoCommit.enabled) {
    ensureCleanGitWorktree(input.cwd);
  }
  const ledger = readSeriesLedger(input.cwd, input.config.seriesId) ??
    initialLedger(input.config);
  const total = input.config.tasks.length;

  for (const [index, task] of input.config.tasks.entries()) {
    const currentHash = taskHash(task, input.config.autoCommit);
    const decision = decideTaskResume({
      taskId: task.id,
      taskHash: currentHash,
      ledgerTask: ledgerTask(ledger, task.id),
    });
    if (decision.action === "stop") {
      ledger.status = "error";
      ledger.updatedAt = nowIso();
      writeSeriesLedger(input.cwd, ledger);
      return { outcome: "error", taskId: task.id, reason: decision.reason };
    }
    if (decision.action === "skip") continue;
    if (decision.action === "commit") {
      const existing = ledgerTask(ledger, task.id)!;
      const commitResult = commitPublishedChanges({
        cwd: input.cwd,
        changedFiles: existing.changedFiles ?? [],
        message: renderCommitMessage({
          template: task.commitMessage ?? input.config.autoCommit.messageTemplate,
          taskId: task.id,
          seriesId: input.config.seriesId,
          index: index + 1,
          total,
        }),
      });
      upsertLedgerTask(ledger, {
        ...existing,
        status: "completed",
        ...(commitResult.committed ? { commit: commitResult.commit } : {}),
        completedAt: nowIso(),
      });
      writeSeriesLedger(input.cwd, ledger);
      continue;
    }

    const selectedContracts = selectTaskContracts({
      contracts: input.contracts,
      task,
      defaults: input.config.taskDefaults,
      fallbackStage: input.fallbackStage,
    });
    upsertLedgerTask(ledger, {
      id: task.id,
      taskHash: currentHash,
      status: "running",
      startedAt: nowIso(),
    });
    writeSeriesLedger(input.cwd, ledger);

    let execution: SeriesTaskExecutionResult;
    try {
      execution = await input.executeTask({
        task,
        contracts: selectedContracts,
        index: index + 1,
        total,
      });
    } catch (error) {
      upsertLedgerTask(ledger, {
        id: task.id,
        taskHash: currentHash,
        status: "error",
        errorReason: error instanceof Error ? error.message : String(error),
      });
      ledger.status = "error";
      writeSeriesLedger(input.cwd, ledger);
      return {
        outcome: "error",
        taskId: task.id,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const runOutcome = execution.outcome;
    if (runOutcome.outcome !== "ready_for_mr") {
      const status = runOutcome.outcome === "blocked" ? "blocked" : "escalated";
      upsertLedgerTask(ledger, {
        id: task.id,
        taskHash: currentHash,
        status,
        runRecord: execution.runRecordPath,
        errorReason: runOutcome.action?.reason,
      });
      ledger.status = status === "blocked" ? "running" : "error";
      writeSeriesLedger(input.cwd, ledger);
      return {
        outcome: runOutcome.outcome,
        taskId: task.id,
        reason: runOutcome.action?.reason,
      };
    }

    const changedFiles = runOutcome.publication?.changedFiles ?? [];
    upsertLedgerTask(ledger, {
      id: task.id,
      taskHash: currentHash,
      status: "ready_to_commit",
      changedFiles,
      runRecord: execution.runRecordPath,
    });
    writeSeriesLedger(input.cwd, ledger);

    let commit: string | undefined;
    if (input.config.autoCommit.enabled) {
      const commitResult = commitPublishedChanges({
        cwd: input.cwd,
        changedFiles,
        message: renderCommitMessage({
          template: task.commitMessage ?? input.config.autoCommit.messageTemplate,
          taskId: task.id,
          seriesId: input.config.seriesId,
          index: index + 1,
          total,
        }),
      });
      if (commitResult.committed) commit = commitResult.commit;
      ensureCleanGitWorktree(input.cwd);
    }

    upsertLedgerTask(ledger, {
      id: task.id,
      taskHash: currentHash,
      status: "completed",
      changedFiles,
      ...(commit ? { commit } : {}),
      runRecord: execution.runRecordPath,
      completedAt: nowIso(),
    });
    writeSeriesLedger(input.cwd, ledger);
  }

  ledger.status = "completed";
  ledger.updatedAt = nowIso();
  writeSeriesLedger(input.cwd, ledger);
  return { outcome: "completed" };
}
```

- [ ] **Step 4: Export runner APIs**

In `src/index.ts`, extend the series export block with:

```typescript
  runTaskSeries,
  type RunTaskSeriesInput,
  type RunTaskSeriesResult,
  type SeriesTaskExecutionInput,
  type SeriesTaskExecutionResult,
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "runTaskSeries"
```

Expected: focused serial runner tests pass.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src/harness/series.ts src/index.ts test/harness-series.test.ts
git commit -m "feat: orchestrate serial tasks"
```

---

## Task 7: Wire Serial Mode Into The CLI

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli-series.test.ts`

- [ ] **Step 1: Add RED CLI tests**

Create `test/cli-series.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-series-"));
  const contracts = join(cwd, "contracts");
  mkdirSync(contracts);
  writeFileSync(
    join(contracts, "smoke.json"),
    JSON.stringify({ id: "smoke.boot", type: "command", cmd: "true" }),
  );
  writeFileSync(
    join(contracts, "domain.json"),
    JSON.stringify({
      id: "domain.model-boundary",
      type: "command",
      stage: "domain",
      cmd: "true",
    }),
  );
  return cwd;
}

test("CLI run with explicit task keeps single-task behavior even when config has tasks", () => {
  const cwd = project();
  writeFileSync(
    join(cwd, "harness.config.json"),
    JSON.stringify({
      autoCommit: { enabled: false },
      tasks: [{ id: "configured", task: "Configured task.", gate: { contracts: ["smoke.boot"] } }],
    }),
  );

  const result = runCli(cwd, [
    "run",
    "Explicit task.",
    "--driver",
    "scaffold",
    "--dir",
    "contracts",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /task="Explicit task\."/);
  assert.doesNotMatch(result.stdout, /series/);
});

test("CLI run without task consumes configured task series", () => {
  const cwd = project();
  writeFileSync(
    join(cwd, "contracts", "unselected-fail.json"),
    JSON.stringify({
      id: "unselected.fail",
      type: "command",
      stage: "other",
      cmd: "false",
    }),
  );
  writeFileSync(
    join(cwd, "harness.config.json"),
    JSON.stringify({
      series: { id: "order-refactor" },
      taskDefaults: { gate: { contracts: ["smoke.boot"] } },
      autoCommit: { enabled: false },
      tasks: [
        { id: "one", task: "Task one." },
        { id: "two", task: "Task two.", gate: { stage: "domain" } },
      ],
    }),
  );

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    "contracts",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /harness series · id=order-refactor · tasks=2/);
  assert.match(result.stdout, /\[1\/2\] one/);
  assert.match(result.stdout, /\[2\/2\] two/);

  const ledger = JSON.parse(
    readFileSync(join(cwd, ".harness", "series", "order-refactor.json"), "utf8"),
  ) as { status: string; tasks: Array<{ id: string; status: string }> };
  assert.equal(ledger.status, "completed");
  assert.deepEqual(
    ledger.tasks.map((task) => [task.id, task.status]),
    [["one", "completed"], ["two", "completed"]],
  );
});

test("CLI run without task errors when config has no task series", () => {
  const cwd = project();

  const result = runCli(cwd, ["run", "--driver", "scaffold", "--dir", "contracts"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法: harness run "<task 描述>"/);
  assert.match(result.stderr, /或在 harness.config.json 配置 tasks/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test dist/test/cli-series.test.js
```

Expected: at least the serial-mode tests fail because CLI still requires a positional task.

- [ ] **Step 3: Import series APIs in CLI**

In `src/cli.ts`, add imports:

```typescript
import {
  loadTaskSeriesConfig,
  runTaskSeries,
} from "./harness/series.js";
```

- [ ] **Step 4: Refactor single-task execution to return a result**

Above `doRun()`, add:

```typescript
interface SingleTaskRunResult {
  outcome: Awaited<ReturnType<typeof runLoop>>;
  runRecordPath: string;
  environmentName: string;
}

interface SingleTaskRunOverrides {
  selectedContracts?: Contract[];
}
```

Change:

```typescript
async function doRun(args: string[], task: string, initialFeedback?: string): Promise<void> {
```

to:

```typescript
async function runSingleTask(
  args: string[],
  task: string,
  initialFeedback?: string,
  overrides: SingleTaskRunOverrides = {},
): Promise<SingleTaskRunResult> {
```

Inside `runSingleTask()`, change selected contract calculation from:

```typescript
const selected = values.stage
  ? selectByStage(contracts, values.stage as string)
  : contracts;
```

to:

```typescript
const selected = overrides.selectedContracts ??
  (values.stage
    ? selectByStage(contracts, values.stage as string)
    : contracts);
```

At the end of the successful `try` block, after setting `process.exitCode`, add:

```typescript
    return {
      outcome,
      runRecordPath: recPath,
      environmentName: environment.name,
    };
```

Then add this wrapper below `runSingleTask()`:

```typescript
async function doRun(args: string[], task: string, initialFeedback?: string): Promise<void> {
  await runSingleTask(args, task, initialFeedback);
}
```

Do not change `cmdFix()` behavior.

- [ ] **Step 5: Add serial CLI route**

Replace `cmdRun()` with:

```typescript
async function cmdRun(args: string[]): Promise<void> {
  const { values, positionals } = parse(args);
  const task = positionals[0];
  if (task) {
    await doRun(args, task);
    return;
  }

  const cwd = process.cwd();
  const config = loadHarnessConfig(
    cwd,
    values.config as string | undefined,
  );
  const series = loadTaskSeriesConfig(config);
  if (!series) {
    fail('用法: harness run "<task 描述>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s]\n或在 harness.config.json 配置 tasks 后运行 harness run [--driver ...]');
  }

  const dir = resolve(cwd, values.dir as string);
  const { contracts, issues } = loadContracts(dir);
  if (issues.length) {
    for (const issue of issues) console.error(`  - ${issue.message}`);
    throw new Error("契约规格有问题,先修复");
  }
  const verificationFailures = contracts.map(verifyFrozen).filter((r) =>
    !r.ok
  );
  if (verificationFailures.length) {
    for (const failure of verificationFailures) {
      console.error(`  - ${failure.message}`);
    }
    throw new Error("冻结契约校验失败");
  }

  console.log(`harness series · id=${series.seriesId} · tasks=${series.tasks.length}`);
  const result = await runTaskSeries({
    cwd,
    config: series,
    contracts,
    fallbackStage: values.stage as string | undefined,
    async executeTask(input) {
      console.log(`\n[${input.index}/${input.total}] ${input.task.id}`);
      const run = await runSingleTask(args, input.task.task, undefined, {
        selectedContracts: input.contracts,
      });
      return {
        outcome: run.outcome,
        runRecordPath: run.runRecordPath,
      };
    },
  });

  if (result.outcome === "completed") {
    console.log("\n✓ series completed");
    process.exitCode = 0;
    return;
  }
  console.log(`\n■ series stopped at ${result.taskId}: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
  process.exitCode = result.outcome === "blocked" ? 2 : 1;
}
```

- [ ] **Step 6: Verify GREEN for CLI serial mode**

Run:

```bash
npm run build && node --test dist/test/cli-series.test.js
```

Expected: all CLI serial tests pass.

- [ ] **Step 7: Run related CLI and series tests**

Run:

```bash
npm run build && node --test dist/test/cli-series.test.js dist/test/harness-series.test.js dist/test/frozen-contract-callers.test.js
```

Expected: all related tests pass.

- [ ] **Step 8: Commit Task 7**

Run:

```bash
git add src/cli.ts test/cli-series.test.ts
git commit -m "feat: run configured task series"
```

---

## Task 8: Document Serial Runs

**Files:**
- Modify: `docs/usage.md`
- Modify: `README.md`

- [ ] **Step 1: Add serial-mode docs to `docs/usage.md`**

In `docs/usage.md`, after section `9. 用 Daytona + Claude 跑真实自动开发`, add:

````markdown
## 9A. 串行执行大型任务

大型重构先拆成多个 task，写入 `harness.config.json`：

```json
{
  "series": { "id": "order-refactor" },
  "taskDefaults": {
    "gate": { "contracts": ["smoke.boot"] }
  },
  "autoCommit": {
    "enabled": true,
    "messageTemplate": "harness: {id}"
  },
  "tasks": [
    {
      "id": "extract-domain-model",
      "task": "抽取订单领域模型",
      "gate": { "contracts": ["domain.model-boundary"] }
    },
    {
      "id": "split-services",
      "task": "拆分服务层职责",
      "gate": { "stage": "service-refactor" }
    }
  ]
}
```

然后不传任务字符串：

```bash
harness run --driver claude --max-attempts 3
```

每个 task 都会创建新的 Agent sandbox 和新的 Claude 会话。单个 task 内部的
gate-fail retry 仍复用该 task 的 Agent sandbox 和 Claude resume session。

每个 task 通过自己的 gate 后，Harness 会发布候选文件到真实工作区，然后只
stage 本次发布的文件并创建一个 git commit。`.harness` 运行记录和 series
ledger 不会进入任务提交。

进度记录在：

```text
.harness/series/<series-id>.json
```

恢复规则：

- `completed` 且 task hash 未变化：跳过；
- `ready_to_commit`：先完成 commit，再继续；
- `running`、`blocked`、`escalated`、`error`：从该 task 重新开始；
- 已完成 task 的配置变化：停止，要求改回原配置或换新 task id；
- 无法解释的 dirty worktree：停止，不启动新的 Agent。
````

- [ ] **Step 2: Add README summary**

In `README.md`, after the paragraph about candidate roots and publication, add:

````markdown
Large work can be split into a configured task series:

```json
{
  "series": { "id": "order-refactor" },
  "taskDefaults": { "gate": { "contracts": ["smoke.boot"] } },
  "tasks": [
    { "id": "extract-domain-model", "task": "Extract the order domain model." },
    { "id": "split-services", "task": "Split service-layer responsibilities." }
  ]
}
```

Run the series with:

```bash
node dist/src/cli.js run --driver claude --max-attempts 3
```

Harness starts a fresh Agent sandbox per task, records progress in
`.harness/series/<series-id>.json`, and commits each gate-approved publication
before moving to the next task.
````

- [ ] **Step 3: Verify docs contain the new commands**

Run:

```bash
rg -n "串行执行大型任务|harness run --driver claude --max-attempts 3|\\.harness/series" docs/usage.md README.md
```

Expected: matches appear in both docs.

- [ ] **Step 4: Commit Task 8**

Run:

```bash
git add docs/usage.md README.md
git commit -m "docs: document serial task runs"
```

---

## Task 9: Final Verification And Archive Notes

**Files:**
- Modify: none unless verification reveals an issue.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run check
```

Expected:

```text
tests ... pass 0 fail
```

The exact test count can increase from the current 367 after adding new tests.

- [ ] **Step 2: Check git status**

Run:

```bash
git status --short
```

Expected: no output.

- [ ] **Step 3: Review commit series**

Run:

```bash
git log --oneline main..HEAD
```

Expected: commits include:

```text
docs: design serial task runner
feat: expose run publication result
feat: initialize git during create
feat: parse serial task config
feat: persist serial task ledger
feat: commit published task changes
feat: orchestrate serial tasks
feat: run configured task series
docs: document serial task runs
```

- [ ] **Step 4: Record unresolved integration caveats in final response**

If Daytona credentials are not available, do not run `npm run test:daytona`.
Report that full unit verification passed and Daytona integration was not run.

---

## Self-review Checklist

- Spec coverage:
  - Backward-compatible explicit `harness run "<task>"`: Task 7.
  - Configured no-position series mode: Tasks 3, 6, 7.
  - Fresh task-level Agent sandbox: Task 7 invokes `runSingleTask()` per task, which constructs a fresh environment each call.
  - Task-level gate selectors: Task 3 and Task 6.
  - Ledger skip/resume behavior: Task 4 and Task 6.
  - Automatic commits of publication paths only: Task 1 and Task 5.
  - `.harness` exclusion: Task 5.
  - `harness create` git init: Task 2.
  - Docs: Task 8.

- Placeholder scan:
  - No steps use unresolved placeholder language.
  - Every test step has concrete code and a focused command.
  - Every implementation step names exact files and exported types.

- Type consistency:
  - `TaskSeriesConfig`, `TaskSeriesTask`, `AutoCommitConfig`, `SeriesLedger`, `SeriesLedgerTask`, `RunTaskSeriesInput`, and `RunTaskSeriesResult` are introduced before later tasks use them.
  - `RunOutcome.publication` is introduced before commit helpers depend on `changedFiles`.
  - `runSingleTask()` returns `runRecordPath` before `runTaskSeries()` consumes it from the CLI callback.

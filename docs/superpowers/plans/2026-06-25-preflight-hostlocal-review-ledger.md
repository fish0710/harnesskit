# Preflight Host-Local Review Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject mis-modeled mini-program command gates during preflight and allow approved review verdicts to unblock a blocked task-series ledger task.

**Architecture:** Keep `isHostLocalContract()` strict: only `type: miniprogram` is host-local. Add a preflight-only static modeling lint for command contracts that clearly contain mini-program automation fields or command text. Make series resume verdict-aware by allowing a `blocked` review task with matching task hash and stored verdict to rerun through the normal GateCore path.

**Tech Stack:** TypeScript, Node.js test runner, existing Harness GateCore, preflight, series ledger, and verdict persistence modules.

---

## File Structure

- Modify `src/harness/preflight.ts`: add a small command-contract modeling lint and include it in `runGatePreflight()` static findings.
- Modify `test/preflight-runtime.test.ts`: add regression coverage proving mis-modeled mini-program command contracts stop before Daytona sandbox creation.
- Modify `src/harness/series.ts`: extend `decideTaskResume()` with an optional verdict-aware flag and teach `runTaskSeries()` to derive that flag for blocked review tasks.
- Modify `test/harness-series.test.ts`: add unit and integration coverage for blocked review verdict resume.

## Task 1: Preflight Rejects Mini-Program Command Contracts

**Files:**
- Modify: `test/preflight-runtime.test.ts`
- Modify: `src/harness/preflight.ts`

- [ ] **Step 1: Write the failing preflight regression test**

Add this test in `test/preflight-runtime.test.ts` immediately after `static lint error returns not_ready and does not create sandbox`:

```ts
test("mini-program command contracts fail preflight before sandbox creation", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const misModeled: Contract = {
    id: "mp.vue3.home-flow",
    type: "command",
    cmd: "node",
    args: ["test/gates/mp-home-flow.js"],
    projectPath: "dist/build/mp-weixin",
    runner: "test/gates/mp-home-flow.js",
    devtools: {
      mode: "managed",
      cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
      autoPort: 9420,
    },
  };

  const report = await runGatePreflight(
    preflightOptions(root, provider, [misModeled]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.selectedContracts, ["mp.vue3.home-flow"]);
  assert.deepEqual(report.remoteContracts, ["mp.vue3.home-flow"]);
  assert.deepEqual(report.hostLocalContracts, []);
  assert.equal(report.readinessErrors[0]?.id, "contract.mp.vue3.home-flow.miniprogramModel");
  assert.match(report.readinessErrors[0]?.message ?? "", /type="miniprogram"/);
  assert.match(report.readinessErrors[0]?.message ?? "", /projectPath/);
  assert.deepEqual(provider.requests, []);
});
```

- [ ] **Step 2: Run the failing preflight test**

Run:

```bash
npm run build
node --test dist/test/preflight-runtime.test.js --test-name-pattern "mini-program command contracts fail preflight"
```

Expected: the named test fails because `readinessErrors[0]?.id` is not `contract.mp.vue3.home-flow.miniprogramModel`, and the fake provider receives a sandbox create request.

- [ ] **Step 3: Implement the static modeling lint**

In `src/harness/preflight.ts`, add this helper near the existing static lint helpers before `export function lintGateReadiness(...)`:

```ts
const MINI_PROGRAM_COMMAND_TEXT =
  /miniprogram-automator|wechatwebdevtools|WeChatDevTools|HARNESS_MINIPROGRAM_/i;

function commandContractMiniProgramSignals(contract: Contract): string[] {
  if (contract.type !== "command") return [];
  const signals: string[] = [];
  for (const field of ["projectPath", "runner", "devtools"] as const) {
    if (Object.prototype.hasOwnProperty.call(contract, field)) signals.push(field);
  }
  const commandText = [
    typeof contract.cmd === "string" ? contract.cmd : "",
    ...(Array.isArray(contract.args) ? contract.args.map(String) : []),
  ].filter(Boolean).join(" ");
  if (MINI_PROGRAM_COMMAND_TEXT.test(commandText)) signals.push("command text");
  return signals;
}

function lintCommandContractModeling(contracts: Contract[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const contract of contracts) {
    const signals = commandContractMiniProgramSignals(contract);
    if (signals.length === 0) continue;
    findings.push(finding(
      `contract.${contract.id}.miniprogramModel`,
      "error",
      `契约 ${contract.id} 是 type="command"，但包含小程序自动化信号(${signals.join(", ")}). ` +
        `微信小程序真实自动化必须建模为 type="miniprogram"，使用 projectPath、runner、devtools；` +
        `type="command" 仅用于可在远端 Gate sandbox 执行的构建、测试、lint 或源码可复现检查。`,
      "contract",
      contract.id,
    ));
  }
  return findings;
}
```

Then change the start of `runGatePreflight()` from:

```ts
const staticFindings = lintGateReadiness({
  contracts: options.contracts,
  policy: options.policy,
  baseUrl,
});
```

to:

```ts
const staticFindings = [
  ...lintGateReadiness({
    contracts: options.contracts,
    policy: options.policy,
    baseUrl,
  }),
  ...lintCommandContractModeling(options.contracts),
];
```

- [ ] **Step 4: Verify the preflight regression passes**

Run:

```bash
npm run build
node --test dist/test/preflight-runtime.test.js --test-name-pattern "mini-program command contracts fail preflight"
```

Expected: the named test passes and no fake sandbox request is recorded.

- [ ] **Step 5: Run targeted preflight coverage**

Run:

```bash
node --test dist/test/host-gate.test.js dist/test/preflight-runtime.test.js dist/test/preflight-lint.test.js
```

Expected: all targeted preflight and host-local tests pass.

- [ ] **Step 6: Commit the preflight fix**

Run:

```bash
git add src/harness/preflight.ts test/preflight-runtime.test.ts
git commit -m "fix: reject miniprogram command preflight contracts"
```

## Task 2: Resume Decision Allows Resolved Blocked Review Tasks

**Files:**
- Modify: `test/harness-series.test.ts`
- Modify: `src/harness/series.ts`

- [ ] **Step 1: Write the failing `decideTaskResume()` unit test**

Add this assertion block inside `test("decideTaskResume stops terminal non-success states for manual handling", ...)`, after the existing blocked assertion and before the escalated assertion:

```ts
assert.deepEqual(
  decideTaskResume({
    taskId: "one",
    taskHash: "hash-a",
    hasResolvedReviewVerdict: true,
    ledgerTask: {
      id: "one",
      taskHash: "hash-a",
      status: "blocked",
      errorReason: "needs review",
    },
  }),
  { action: "run" },
);

assert.deepEqual(
  decideTaskResume({
    taskId: "one",
    taskHash: "hash-b",
    hasResolvedReviewVerdict: true,
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
```

- [ ] **Step 2: Run the failing decision test**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "decideTaskResume stops terminal non-success states"
```

Expected: the first new assertion fails because `decideTaskResume()` still returns `stop` for every blocked task.

- [ ] **Step 3: Extend `decideTaskResume()`**

Change the input type in `src/harness/series.ts` from:

```ts
export function decideTaskResume(input: {
  taskId: string;
  taskHash: string;
  ledgerTask?: SeriesLedgerTask;
}): TaskResumeDecision {
```

to:

```ts
export function decideTaskResume(input: {
  taskId: string;
  taskHash: string;
  ledgerTask?: SeriesLedgerTask;
  hasResolvedReviewVerdict?: boolean;
}): TaskResumeDecision {
```

Then insert this branch immediately before the existing terminal-state block that checks `blocked`, `escalated`, and `error`:

```ts
if (
  existing.status === "blocked" &&
  existing.taskHash === input.taskHash &&
  input.hasResolvedReviewVerdict === true
) {
  return { action: "run" };
}
```

- [ ] **Step 4: Verify the decision test passes**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "decideTaskResume stops terminal non-success states"
```

Expected: the named test passes.

## Task 3: `runTaskSeries()` Reruns Blocked Review Tasks With Verdicts

**Files:**
- Modify: `test/harness-series.test.ts`
- Modify: `src/harness/series.ts`

- [ ] **Step 1: Add integration tests for blocked review resume**

Add these two tests in `test/harness-series.test.ts` after `runTaskSeries stops on blocked outcome without running later tasks`:

```ts
test("runTaskSeries reruns blocked review task when a matching verdict exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-review-resume-"));
  const config = loadTaskSeriesConfig({
    series: { id: "review-series" },
    taskDefaults: { gate: { contracts: ["product.approval"] } },
    autoCommit: { enabled: false, messageTemplate: "harness: {id}" },
    tasks: [{ id: "review-task", task: "Needs approval." }],
  })!;
  const reviewContracts: Contract[] = [
    { id: "product.approval", type: "review" },
  ];
  const currentTaskHash = taskHash(config.tasks[0]!, config.autoCommit, config.taskDefaults);
  writeSeriesLedger(cwd, {
    schemaVersion: 1,
    seriesId: "review-series",
    status: "running",
    configHash: configHash(config),
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    tasks: [
      {
        id: "review-task",
        taskHash: currentTaskHash,
        status: "blocked",
        startedAt: "2026-06-25T00:00:00.000Z",
        errorReason: "needs product approval",
        runRecord: ".harness/runs/review-task.json",
      },
    ],
  });
  mkdirSync(join(cwd, ".harness"), { recursive: true });
  writeFileSync(
    join(cwd, ".harness", "verdicts.json"),
    JSON.stringify({
      "product.approval": {
        optionId: "approve",
        by: "tester",
        at: "2026-06-25T00:00:01.000Z",
      },
    }),
    "utf8",
  );
  const executed: SeriesTaskExecutionInput[] = [];

  const result = await runTaskSeries({
    cwd,
    config,
    contracts: reviewContracts,
    executeTask: async (input) => {
      executed.push(input);
      return {
        outcome: readyOutcome([]),
        runRecordPath: ".harness/runs/review-task-rerun.json",
      };
    },
  });

  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(executed.map((input) => input.task.id), ["review-task"]);
  assert.deepEqual(executed[0]?.contracts.map((contract) => contract.id), ["product.approval"]);
  const ledger = readSeriesLedger(cwd, "review-series")!;
  assert.equal(ledger.status, "completed");
  assert.equal(ledger.tasks[0]?.status, "completed");
  assert.equal(ledger.tasks[0]?.runRecord, ".harness/runs/review-task-rerun.json");
});

test("runTaskSeries keeps blocked review task stopped when no verdict exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-review-still-blocked-"));
  const config = loadTaskSeriesConfig({
    series: { id: "review-series" },
    taskDefaults: { gate: { contracts: ["product.approval"] } },
    autoCommit: { enabled: false, messageTemplate: "harness: {id}" },
    tasks: [{ id: "review-task", task: "Needs approval." }],
  })!;
  const currentTaskHash = taskHash(config.tasks[0]!, config.autoCommit, config.taskDefaults);
  writeSeriesLedger(cwd, {
    schemaVersion: 1,
    seriesId: "review-series",
    status: "running",
    configHash: configHash(config),
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    tasks: [
      {
        id: "review-task",
        taskHash: currentTaskHash,
        status: "blocked",
        errorReason: "needs product approval",
      },
    ],
  });
  const executed: string[] = [];

  const result = await runTaskSeries({
    cwd,
    config,
    contracts: [{ id: "product.approval", type: "review" }],
    executeTask: async (input) => {
      executed.push(input.task.id);
      return {
        outcome: readyOutcome([]),
        runRecordPath: ".harness/runs/unexpected.json",
      };
    },
  });

  assert.deepEqual(result, {
    outcome: "error",
    taskId: "review-task",
    reason: "task review-task 已处于 blocked 状态，需人工处理后再继续",
  });
  assert.deepEqual(executed, []);
});
```

- [ ] **Step 2: Run the failing integration tests**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "runTaskSeries .*blocked review"
```

Expected: the `reruns blocked review task` test fails because `runTaskSeries()` stops before it checks `.harness/verdicts.json`.

- [ ] **Step 3: Import verdict loading in `series.ts`**

Add this import near the existing imports in `src/harness/series.ts`:

```ts
import { loadVerdicts } from "./verdicts.js";
```

- [ ] **Step 4: Add pure helpers for review verdict matching**

Add these helpers near `decideTaskResume()` in `src/harness/series.ts`:

```ts
function hasSelectedResolvedReviewVerdict(
  selectedContracts: Contract[],
  verdicts: Record<string, unknown>,
): boolean {
  return selectedContracts.some((contract) =>
    contract.type === "review" &&
    Object.prototype.hasOwnProperty.call(verdicts, contract.id)
  );
}

function shouldInspectBlockedReviewResume(
  ledgerTask: SeriesLedgerTask | undefined,
  currentTaskHash: string,
): boolean {
  return ledgerTask?.status === "blocked" && ledgerTask.taskHash === currentTaskHash;
}
```

- [ ] **Step 5: Compute verdict-aware resume input in `runTaskSeries()`**

In `runTaskSeries()`, add verdict loading after `const cwd = input.cwd;`:

```ts
const verdicts = loadVerdicts(cwd);
```

Then replace the current decision setup:

```ts
const existingTask = ledger.tasks.find((entry) => entry.id === task.id);
const decision = decideTaskResume({
  taskId: task.id,
  taskHash: currentTaskHash,
  ledgerTask: existingTask,
});
```

with:

```ts
const existingTask = ledger.tasks.find((entry) => entry.id === task.id);
let preselectedContracts: Contract[] | undefined;
let hasResolvedReviewVerdict = false;
if (shouldInspectBlockedReviewResume(existingTask, currentTaskHash)) {
  try {
    preselectedContracts = selectTaskContracts({
      contracts: input.contracts,
      task,
      defaults: config.taskDefaults,
      fallbackStage: input.fallbackStage,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const runRecordPath = await input.recordTaskSetupError?.({
      task,
      index,
      total,
      error,
    });
    updateLedgerTask(ledger, {
      id: task.id,
      taskHash: currentTaskHash,
      status: "error",
      startedAt: nowIso(),
      errorReason: reason,
      ...(runRecordPath ? { runRecord: runRecordPath } : {}),
    });
    ledger.status = "error";
    writeUpdatedLedger(cwd, ledger);
    return { outcome: "error", taskId: task.id, reason };
  }
  hasResolvedReviewVerdict = hasSelectedResolvedReviewVerdict(
    preselectedContracts,
    verdicts,
  );
}
const decision = decideTaskResume({
  taskId: task.id,
  taskHash: currentTaskHash,
  ledgerTask: existingTask,
  hasResolvedReviewVerdict,
});
```

- [ ] **Step 6: Reuse preselected contracts when rerunning**

In the later selected-contract setup block, change:

```ts
let selectedContracts: Contract[];
try {
  selectedContracts = selectTaskContracts({
    contracts: input.contracts,
    task,
    defaults: config.taskDefaults,
    fallbackStage: input.fallbackStage,
  });
} catch (error) {
```

to:

```ts
let selectedContracts: Contract[];
try {
  selectedContracts = preselectedContracts ?? selectTaskContracts({
    contracts: input.contracts,
    task,
    defaults: config.taskDefaults,
    fallbackStage: input.fallbackStage,
  });
} catch (error) {
```

- [ ] **Step 7: Verify the blocked review integration tests pass**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "blocked review"
```

Expected: both blocked review tests pass.

- [ ] **Step 8: Run all series tests**

Run:

```bash
node --test dist/test/harness-series.test.js dist/test/cli-series.test.js
```

Expected: all series tests pass.

- [ ] **Step 9: Commit the series fix**

Run:

```bash
git add src/harness/series.ts test/harness-series.test.ts
git commit -m "fix: resume blocked review tasks with verdicts"
```

## Task 4: Final Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run targeted combined tests**

Run:

```bash
npm run build
node --test dist/test/host-gate.test.js dist/test/preflight-runtime.test.js dist/test/preflight-lint.test.js dist/test/harness-series.test.js dist/test/cli-series.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run the full repository check**

Run:

```bash
npm run check
```

Expected: `tests 579` or higher, `fail 0`. If the sandboxed runner reports `listen EPERM 127.0.0.1`, rerun the same command in the unrestricted environment because several existing tests intentionally bind local loopback.

- [ ] **Step 3: Inspect final diff and log**

Run:

```bash
git status --short
git log --oneline -4
```

Expected: clean worktree and recent commits for the design doc plus the two implementation fixes.

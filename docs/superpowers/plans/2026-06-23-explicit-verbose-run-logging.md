# Explicit Verbose Run Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit `--verbose` run diagnostics that print in real time and persist per-run JSONL logs without changing non-verbose output.

**Architecture:** Add a focused diagnostic logger module that owns terminal rendering and JSONL persistence. Wire it into `runSingleTask`, series execution, Daytona observations, and `runLoop`, then link its path from RunStore records.

**Tech Stack:** TypeScript, Node.js `node:test`, JSONL files under `.harness/runs`, existing RunStore and CLI patterns.

---

## File Structure

- Create `src/harness/diagnostic-log.ts`: diagnostic logger factory, log path helper, JSONL append, compact stdout rendering, and disabled no-op logger.
- Create `src/harness/redaction.ts`: move the existing recursive redaction helper out of `src/cli.ts` so both CLI and logger can reuse it.
- Modify `src/cli.ts`: add `--verbose`, create loggers for run/fix/series, log setup and error phases, re-export `redactObservationData` for existing tests.
- Modify `src/harness/run.ts`: accept an optional diagnostic logger sink and emit loop/publish/close diagnostics.
- Modify `src/harness/record.ts`: add optional `diagnosticLogPath` field and `RunRecorder.setDiagnosticLogPath`.
- Add `test/diagnostic-log.test.ts`: unit coverage for disabled and enabled logger behavior.
- Modify `test/run-store.test.ts`: record validation for `diagnosticLogPath`.
- Modify `test/cli-run-record.test.ts`: CLI behavior with and without `--verbose`, including setup error logging.
- Modify `docs/usage.md`: document `--verbose` on `harness run`/`fix`.

---

### Task 1: Diagnostic Logger And Shared Redaction

**Files:**
- Create: `src/harness/diagnostic-log.ts`
- Create: `src/harness/redaction.ts`
- Modify: `src/cli.ts`
- Test: `test/diagnostic-log.test.ts`
- Test: `test/cli-redaction.test.ts`

- [ ] **Step 1: Write the failing diagnostic logger tests**

Add `test/diagnostic-log.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDiagnosticLogger,
  diagnosticLogPath,
} from "../src/harness/diagnostic-log.js";
import { redactObservationData } from "../src/harness/redaction.js";

test("disabled diagnostic logger is silent and has no path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-diagnostic-log-disabled-"));
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    enabled: false,
    cwd,
    runId: "run-1",
    write: (line) => lines.push(line),
    now: () => "2026-06-23T00:00:00.000Z",
    redact: redactObservationData,
  });

  logger.info("run.setup", "ignored", { token: "secret" });
  logger.close();

  assert.equal(logger.enabled, false);
  assert.equal(logger.path, undefined);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(diagnosticLogPath(cwd, "run-1")), false);
});

test("enabled diagnostic logger writes redacted JSONL and compact output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-diagnostic-log-enabled-"));
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    enabled: true,
    cwd,
    runId: "run-2",
    write: (line) => lines.push(line),
    now: () => "2026-06-23T00:00:00.000Z",
    redact: redactObservationData,
  });

  logger.debug("run.setup", "agent selected", {
    kind: "claude",
    apiKey: "secret",
    nested: { cookie: "session" },
  });
  logger.close();

  assert.equal(logger.enabled, true);
  assert.equal(logger.path, diagnosticLogPath(cwd, "run-2"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /debug run\.setup agent selected/);
  assert.match(lines[0]!, /"apiKey":"\[redacted\]"/);
  assert.doesNotMatch(lines[0]!, /secret|session/);

  const entries = readFileSync(logger.path!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as {
      at: string;
      level: string;
      phase: string;
      message: string;
      data: { apiKey?: string; nested?: { cookie?: string } };
    });
  assert.deepEqual(entries, [
    {
      at: "2026-06-23T00:00:00.000Z",
      level: "debug",
      phase: "run.setup",
      message: "agent selected",
      data: {
        kind: "claude",
        apiKey: "[redacted]",
        nested: { cookie: "[redacted]" },
      },
    },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build && node --test dist/test/diagnostic-log.test.js dist/test/cli-redaction.test.js
```

Expected: FAIL because `src/harness/diagnostic-log.ts` and `src/harness/redaction.ts` do not exist.

- [ ] **Step 3: Move redaction into a shared module**

Create `src/harness/redaction.ts` with the existing logic from `src/cli.ts`:

```ts
const SECRET_OBSERVATION_KEY =
  /(?:api[_-]?key|key|token|secret|password|authorization|auth|cookie)/i;

function isSecretObservationKey(key: string): boolean {
  return SECRET_OBSERVATION_KEY.test(key);
}

export function redactObservationData(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return "[unserializable]";
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactObservationData(item, seen));
  }

  const output: Record<string, unknown> = {};
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value);
  } catch {
    return "[unserializable]";
  }
  for (const [key, item] of entries) {
    output[key] = isSecretObservationKey(key)
      ? "[redacted]"
      : redactObservationData(item, seen);
  }
  return output;
}
```

Update `src/cli.ts` imports and re-export:

```ts
import { redactObservationData } from "./harness/redaction.js";

export { redactObservationData } from "./harness/redaction.js";
```

Delete the old `SECRET_OBSERVATION_KEY`, `isSecretObservationKey`, and local
`redactObservationData` definitions from `src/cli.ts`.

- [ ] **Step 4: Implement the diagnostic logger module**

Create `src/harness/diagnostic-log.ts`:

```ts
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  at: string;
  level: DiagnosticLogLevel;
  phase: string;
  message: string;
  data?: unknown;
}

export interface DiagnosticLogger {
  readonly enabled: boolean;
  readonly path?: string;
  log(
    level: DiagnosticLogLevel,
    phase: string,
    message: string,
    data?: unknown,
  ): void;
  debug(phase: string, message: string, data?: unknown): void;
  info(phase: string, message: string, data?: unknown): void;
  warn(phase: string, message: string, data?: unknown): void;
  error(phase: string, message: string, data?: unknown): void;
  close(): void;
}

export interface CreateDiagnosticLoggerOptions {
  enabled: boolean;
  cwd: string;
  runId: string;
  now?: () => string;
  write?: (line: string) => void;
  redact?: (value: unknown) => unknown;
}

function assertSafeRunId(runId: string): void {
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error("runId must be a non-empty safe path segment");
  }
}

export function diagnosticLogPath(cwd: string, runId: string): string {
  assertSafeRunId(runId);
  return join(cwd, ".harness", "runs", `${runId}.log.jsonl`);
}

function renderEntry(entry: DiagnosticLogEntry): string {
  const suffix = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
  return `[${entry.at}] ${entry.level} ${entry.phase} ${entry.message}${suffix}`;
}

export function createDiagnosticLogger(
  options: CreateDiagnosticLoggerOptions,
): DiagnosticLogger {
  if (!options.enabled) {
    return {
      enabled: false,
      log() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      close() {},
    };
  }

  const path = diagnosticLogPath(options.cwd, options.runId);
  mkdirSync(join(options.cwd, ".harness", "runs"), { recursive: true });
  const fd = openSync(path, "a");
  const now = options.now ?? (() => new Date().toISOString());
  const write = options.write ?? ((line: string) => console.log(line));
  const redact = options.redact ?? ((value: unknown) => value);
  let closed = false;

  const logger: DiagnosticLogger = {
    enabled: true,
    path,
    log(level, phase, message, data) {
      if (closed) return;
      const redacted = data === undefined ? undefined : redact(data);
      const entry: DiagnosticLogEntry = {
        at: now(),
        level,
        phase,
        message,
        ...(redacted === undefined ? {} : { data: redacted }),
      };
      write(renderEntry(entry));
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    },
    debug(phase, message, data) {
      logger.log("debug", phase, message, data);
    },
    info(phase, message, data) {
      logger.log("info", phase, message, data);
    },
    warn(phase, message, data) {
      logger.log("warn", phase, message, data);
    },
    error(phase, message, data) {
      logger.log("error", phase, message, data);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
  return logger;
}
```

- [ ] **Step 5: Run tests to verify Task 1 passes**

Run:

```bash
npm run build && node --test dist/test/diagnostic-log.test.js dist/test/cli-redaction.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/harness/diagnostic-log.ts src/harness/redaction.ts src/cli.ts test/diagnostic-log.test.ts test/cli-redaction.test.ts
git commit -m "feat: add diagnostic run logger"
```

---

### Task 2: RunStore Diagnostic Log Path

**Files:**
- Modify: `src/harness/record.ts`
- Test: `test/run-store.test.ts`

- [ ] **Step 1: Write the failing RunStore test**

Append to `test/run-store.test.ts`:

```ts
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
```

In `RunStore rejects v3 records with invalid optional fields`, add:

```ts
record.diagnosticLogPath = 42;
```

and keep the expected `readRun` result as `undefined`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/run-store.test.js
```

Expected: FAIL because `setDiagnosticLogPath` and `diagnosticLogPath` record
validation do not exist.

- [ ] **Step 3: Implement RunStore support**

Update `src/harness/record.ts`:

```ts
export interface RunRecordV3 {
  schemaVersion: 3;
  runId: string;
  kind: RunRecordKind;
  parentRunId?: string;
  createdAt: string;
  updatedAt: string;
  repo: RunRecordRepo;
  task: RunRecordTask;
  driver: string;
  status: RunRecordStatus;
  observability: RunRecordObservability;
  selectedContracts: string[];
  attempts: RunRecordAttempt[];
  attemptCount?: number;
  events: RunRecordEvent[];
  children?: RunRecordChild[];
  logs?: string[];
  diagnosticLogPath?: string;
  report?: GateReport;
  publication?: PublicationResult;
  outcome?: RunRecordOutcome;
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  errorReason?: string;
}
```

Add a method to `RunRecorder`:

```ts
setDiagnosticLogPath(path: string): void {
  this.record.diagnosticLogPath = path;
  this.write();
}
```

Update `toRunRecordV3` validation:

```ts
(record.diagnosticLogPath !== undefined &&
  typeof record.diagnosticLogPath !== "string") ||
```

Place it beside the existing optional `logs` validation.

- [ ] **Step 4: Run test to verify Task 2 passes**

Run:

```bash
npm run build && node --test dist/test/run-store.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/harness/record.ts test/run-store.test.ts
git commit -m "feat: link diagnostic logs from run records"
```

---

### Task 3: Run Loop Diagnostic Events

**Files:**
- Modify: `src/harness/run.ts`
- Test: `test/harness-run.test.ts`

- [ ] **Step 1: Write the failing run loop test**

Add to `test/harness-run.test.ts` before the verdict storage tests:

```ts
test("runLoop emits diagnostic events for attempts, gates, publish, and close", async () => {
  const events: Array<{ level: string; phase: string; message: string; data?: unknown }> = [];
  const environment: RunEnvironment = {
    name: "diagnostic",
    async runTask() {
      return { summary: "done", changedFiles: ["src/a.ts"] };
    },
    async runGate({ contracts, gate, ctx }) {
      return gate.run(contracts, ctx);
    },
    async publish() {
      return { ok: true, changedFiles: ["src/a.ts"] };
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
    diagnosticLog: {
      debug(phase, message, data) {
        events.push({ level: "debug", phase, message, data });
      },
      info(phase, message, data) {
        events.push({ level: "info", phase, message, data });
      },
      warn(phase, message, data) {
        events.push({ level: "warn", phase, message, data });
      },
      error(phase, message, data) {
        events.push({ level: "error", phase, message, data });
      },
    },
  });

  assert.equal(out.outcome, "ready_for_mr");
  assert.deepEqual(
    events.map((event) => `${event.level}:${event.phase}:${event.message}`),
    [
      "info:loop:attempt start",
      "debug:loop:agent run start",
      "debug:loop:agent run end",
      "debug:loop:gate run start",
      "debug:loop:gate run end",
      "debug:loop:publish start",
      "debug:loop:publish end",
      "info:loop:environment close start",
      "info:loop:environment close end",
    ],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/harness-run.test.js
```

Expected: FAIL because `RunOptions` does not accept `diagnosticLog`.

- [ ] **Step 3: Implement run loop diagnostic hooks**

Update `src/harness/run.ts`:

```ts
export interface RunDiagnosticLog {
  debug(phase: string, message: string, data?: unknown): void;
  info(phase: string, message: string, data?: unknown): void;
  warn(phase: string, message: string, data?: unknown): void;
  error(phase: string, message: string, data?: unknown): void;
}

export interface RunOptions {
  task: string;
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  environment: RunEnvironment;
  budget: GenerationBudget;
  initialFeedback?: string;
  contextUsedRatio?: () => number;
  onLog?: (line: string) => void;
  diagnosticLog?: RunDiagnosticLog;
}
```

In `runLoop`, call `o.diagnosticLog` at these exact points:

```ts
o.diagnosticLog?.info("loop", "attempt start", {
  attempt: state.attempts,
  environment: o.environment.name,
  feedbackBytes: Buffer.byteLength(feedback),
});
o.diagnosticLog?.debug("loop", "agent run start", { attempt: state.attempts });
const act = await o.environment.runTask({ task: o.task, feedback });
o.diagnosticLog?.debug("loop", "agent run end", {
  attempt: state.attempts,
  summary: act.summary,
  changedFiles: act.changedFiles,
});
o.diagnosticLog?.debug("loop", "gate run start", {
  attempt: state.attempts,
  contracts: o.contracts.map((contract) => contract.id),
});
const report = await o.environment.runGate({
  contracts: o.contracts,
  gate: o.gate,
  ctx: o.ctx,
});
o.diagnosticLog?.debug("loop", "gate run end", {
  attempt: state.attempts,
  outcome: report.outcome,
  summary: report.summary,
});
```

Add publish, retry/escalation, and close diagnostics:

```ts
o.diagnosticLog?.debug("loop", "publish start", { attempt: state.attempts });
const publication = await o.environment.publish();
o.diagnosticLog?.debug("loop", "publish end", { attempt: state.attempts, publication });
```

In the `finally` block:

```ts
o.diagnosticLog?.info("loop", "environment close start", {
  environment: o.environment.name,
});
await o.environment.close();
o.diagnosticLog?.info("loop", "environment close end", {
  environment: o.environment.name,
});
```

- [ ] **Step 4: Run test to verify Task 3 passes**

Run:

```bash
npm run build && node --test dist/test/harness-run.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/harness/run.ts test/harness-run.test.ts
git commit -m "feat: emit run loop diagnostics"
```

---

### Task 4: CLI Verbose Wiring And Documentation

**Files:**
- Modify: `src/cli.ts`
- Modify: `docs/usage.md`
- Test: `test/cli-run-record.test.ts`

- [ ] **Step 1: Write failing CLI verbose tests**

Add to `test/cli-run-record.test.ts`:

```ts
test("CLI scaffold run with --verbose writes diagnostic JSONL and records its path", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "verbose scaffold task",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
      "--verbose",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /debug run\.setup/);
  assert.match(result.stdout, /Diagnostic log:/);

  const record = latestRunRecord(cwd);
  assert.equal(typeof record.diagnosticLogPath, "string");
  const diagnosticLogPath = record.diagnosticLogPath as string;
  assert.equal(existsSync(diagnosticLogPath), true);
  const entries = readFileSync(diagnosticLogPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { phase?: string; message?: string });
  assert.ok(entries.some((entry) => entry.phase === "run.setup" && entry.message === "agent selected"));
  assert.ok(entries.some((entry) => entry.phase === "loop" && entry.message === "attempt start"));
});

test("CLI scaffold run without --verbose does not write diagnostic log path", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "quiet scaffold task",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /debug run\.setup/);
  assert.doesNotMatch(result.stdout, /Diagnostic log:/);

  const record = latestRunRecord(cwd);
  assert.equal(record.diagnosticLogPath, undefined);
});

test("CLI verbose setup failure records error diagnostic entry", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "verbose setup failure",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
      "--properties",
      "missing-properties.js",
      "--verbose",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const record = latestRunRecord(cwd);
  assert.equal(record.status, "error");
  assert.equal(typeof record.diagnosticLogPath, "string");
  const entries = readFileSync(record.diagnosticLogPath as string, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { level?: string; phase?: string; message?: string });
  assert.ok(entries.some((entry) =>
    entry.level === "error" &&
    entry.phase === "run.setup" &&
    entry.message === "run failed"
  ));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/cli-run-record.test.js
```

Expected: FAIL because `--verbose` is not parsed and no diagnostic log is wired.

- [ ] **Step 3: Wire verbose mode in `src/cli.ts`**

Add imports:

```ts
import {
  createDiagnosticLogger,
  type DiagnosticLogger,
} from "./harness/diagnostic-log.js";
import { redactObservationData } from "./harness/redaction.js";
export { redactObservationData } from "./harness/redaction.js";
```

Add to `OPTIONS`:

```ts
verbose: { type: "boolean" as const, default: false },
```

Add helper:

```ts
function isVerboseRun(values: Record<string, unknown>, env = process.env): boolean {
  if (values.verbose === true) return true;
  const value = env.HARNESS_VERBOSE;
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
```

In `runSingleTask`, after `recorder` is created:

```ts
const diagnosticLog = createDiagnosticLogger({
  enabled: isVerboseRun(values),
  cwd,
  runId,
  redact: redactObservationData,
});
if (diagnosticLog.path) recorder.setDiagnosticLogPath(diagnosticLog.path);
diagnosticLog.info("run.setup", "run record created", {
  runId,
  kind: overrides?.kind ?? "single",
  driver: runRecordDriverLabel(values),
});
```

Use `diagnosticLog` through setup:

```ts
diagnosticLog.debug("run.setup", "agent selected", agent);
diagnosticLog.debug("run.setup", "contracts loaded", { dir, count: contracts.length });
diagnosticLog.debug("run.setup", "contracts selected", {
  ids: selected.map((contract) => contract.id),
});
diagnosticLog.debug("run.setup", "gate built", {
  properties: values.properties ?? null,
});
diagnosticLog.debug("run.setup", "policy loaded", policy);
diagnosticLog.debug("run.setup", "budget built", budget);
```

For preflight:

```ts
diagnosticLog.info("preflight", "gate preflight start", {
  selectedContracts: selected.map((contract) => contract.id),
});
diagnosticLog.info("preflight", "gate preflight end", preflightEventSummary(preflight));
if (preflightBlocker) {
  diagnosticLog.error("preflight", "gate preflight blocked", {
    reason: preflightBlocker,
  });
}
```

For Daytona observations:

```ts
onObservation(event, data) {
  recorder?.recordEvent(event, data);
  const redacted = redactObservationData(data);
  diagnosticLog.debug("sandbox", event, redacted);
  if (diagnosticLog.enabled) return;
  console.log(`    · ${event}: ${JSON.stringify(redacted)}`);
},
```

Pass into `runLoop`:

```ts
diagnosticLog: diagnosticLog.enabled ? diagnosticLog : undefined,
```

In success output:

```ts
if (diagnosticLog.path) console.log(`Diagnostic log: ${diagnosticLog.path}`);
```

In `catch`:

```ts
diagnosticLog.error("run.setup", "run failed", {
  error: error instanceof Error ? error.message : String(error),
});
recorder.fail(error);
throw error;
```

In `finally`:

```ts
diagnosticLog.close();
```

- [ ] **Step 4: Wire series parent diagnostics**

In `cmdRun` series path, create a parent `diagnosticLog` after `seriesRecorder`:

```ts
const diagnosticLog = createDiagnosticLogger({
  enabled: isVerboseRun(values),
  cwd,
  runId: seriesRunId,
  redact: redactObservationData,
});
if (diagnosticLog.path) seriesRecorder.setDiagnosticLogPath(diagnosticLog.path);
diagnosticLog.info("series", "series start", {
  seriesId: seriesConfig.seriesId,
  tasks: seriesConfig.tasks.length,
});
```

Log skipped tasks, child task starts, setup errors, and final stop/completion:

```ts
diagnosticLog.info("series", "task skipped", { taskId: input.task.id });
diagnosticLog.info("series", "task start", {
  taskId: input.task.id,
  index: input.index,
  total: input.total,
});
diagnosticLog.error("series", "task setup failed", {
  taskId: input.task.id,
  error: input.error instanceof Error ? input.error.message : String(input.error),
});
diagnosticLog.info("series", "series completed", progress);
diagnosticLog.warn("series", "series stopped", stopDetails);
```

Close the series logger in a `finally` block.

- [ ] **Step 5: Update help and usage docs**

In `help()` update the run/fix line:

```text
harness run  "<task>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s] [--max-attempts n] [--max-ms ms] [--verbose]
harness fix  [--driver ...] [--stage s] [--verbose]
```

Add a short `docs/usage.md` section:

```md
### Verbose run diagnostics

Use `--verbose` or `HARNESS_VERBOSE=1` with `harness run` and `harness fix`
to print detailed setup, preflight, sandbox, loop, and series diagnostics while
also writing `.harness/runs/<runId>.log.jsonl`. The run record includes
`diagnosticLogPath` when this mode is enabled. Non-verbose runs keep the normal
compact output.
```

- [ ] **Step 6: Run tests to verify Task 4 passes**

Run:

```bash
npm run build && node --test dist/test/cli-run-record.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add src/cli.ts docs/usage.md test/cli-run-record.test.ts
git commit -m "feat: wire verbose run diagnostics"
```

---

### Task 5: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm run build && node --test dist/test/diagnostic-log.test.js dist/test/cli-redaction.test.js dist/test/run-store.test.js dist/test/harness-run.test.js dist/test/cli-run-record.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full project check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only verbose logging implementation files and docs are changed relative
to the branch work.

- [ ] **Step 4: Final commit if needed**

If any verification-only fixes were made after Task 4, commit them:

```bash
git add src/harness/diagnostic-log.ts src/harness/redaction.ts src/harness/record.ts src/harness/run.ts src/cli.ts test/diagnostic-log.test.ts test/run-store.test.ts test/harness-run.test.ts test/cli-run-record.test.ts docs/usage.md
git commit -m "test: verify verbose run diagnostics"
```

If there are no new changes after Task 4, do not create an empty commit.

# Daytona Claude Observability Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `.claude` artifacts for Daytona Claude runs by default and write a host-side run manifest that points to the durable Daytona volume path.

**Architecture:** Add a small observability config/path module, extend run records with a v2 incremental recorder, add optional Daytona volume mounts to Agent sandbox creation, and inject attempt-scoped `CLAUDE_CONFIG_DIR` into the remote Claude command. Gate sandboxes keep their current isolation and never receive the observability volume.

**Tech Stack:** TypeScript ESM, Node.js `node:test`, Daytona SDK 0.186.0, existing Harness sandbox abstractions.

---

## File Structure

- Create `src/harness/observability.ts`
  - Owns default-on Daytona observability configuration.
  - Builds stable run ids and attempt-scoped Claude artifact paths.
  - Contains no Daytona SDK imports.

- Modify `src/harness/record.ts`
  - Keep the existing v1 `RunRecord` writer for scaffold and non-Claude paths.
  - Add `RunRecordV2`, `RunRecorder`, and `createRunRecorder()`.
  - Make `lastRunRecord()` understand both v1 and v2 records.

- Modify `src/harness/sandbox/types.ts`
  - Add `SandboxVolumeMount`.
  - Allow `SandboxCreateRequest` to include optional `volumes`.

- Modify `src/harness/sandbox/daytona.ts`
  - Add volume service typing.
  - Resolve requested volume mounts with `daytona.volume.get(name, true)`.
  - Pass resolved mounts through to `Daytona.create()`.

- Modify `src/harness/sandbox/environment.ts`
  - Accept observability run config.
  - Mount the configured volume only for Claude Agent sandboxes.
  - Create the attempt directory before Claude runs.
  - Inject `CLAUDE_CONFIG_DIR`, `HARNESS_RUN_ID`, `HARNESS_ATTEMPT`, `HARNESS_OBSERVABILITY_RUN_ROOT`, and `HARNESS_OBSERVABILITY_ATTEMPT_ROOT`.
  - Include `attempt` and artifact paths in safe host observation events.

- Modify `src/cli.ts`
  - For Daytona Claude runs, create the v2 run recorder before constructing the Daytona run environment.
  - Fan out raw events to the manifest and redacted events to the console.
  - Mark the v2 record completed or errored.
  - Use v1 `writeRunRecord()` for scaffold and command driver paths.

- Modify `src/index.ts`
  - Export the new observability and recorder types/functions.

- Create `test/observability.test.ts`
  - Covers config defaults, disabled mode, path building, v2 recorder writes, v1 compatibility, and status compatibility.

- Modify `test/daytona-sandbox.test.ts`
  - Covers provider volume resolution and create request mapping.

- Modify `test/daytona-environment.test.ts`
  - Covers Agent-only volume mounting and Claude env injection.

- Modify `test/frozen-contract-callers.test.ts`
  - Covers CLI error path still writes a v2 record before any Agent sandbox work.

- Modify docs:
  - `README.md`
  - `docs/daytona-local-claude-code-runbook.md`
  - `docs/architecture/daytona-sandbox-gate.md`
  - `docs/architecture/daytona-langfuse-observability.md`

## Task 1: Observability Config And Path Builder

**Files:**
- Create: `src/harness/observability.ts`
- Create: `test/observability.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests for config defaults, disabled mode, validation, run id, and paths**

Create `test/observability.test.ts` with:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
  buildRunId,
  claudeObservabilityPaths,
  loadDaytonaObservabilityConfig,
} from "../src/harness/observability.js";

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

test("claudeObservabilityPaths builds attempt scoped Claude config paths", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "/harness-observability/",
  });

  const paths = claudeObservabilityPaths(config, "run-1", 2);

  assert.deepEqual(paths, {
    runRoot: "/harness-observability/runs/run-1",
    attemptRoot: "/harness-observability/runs/run-1/attempt-2",
    claudeConfigDir: "/harness-observability/runs/run-1/attempt-2/.claude",
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
```

- [ ] **Step 2: Run the test and verify it fails because the module does not exist**

Run:

```bash
npm run build && node --test dist/test/observability.test.js
```

Expected: TypeScript build fails with a missing `src/harness/observability.ts`
module error.

- [ ] **Step 3: Implement `src/harness/observability.ts`**

Create `src/harness/observability.ts`:

```ts
import { randomUUID } from "node:crypto";
import { posix } from "node:path";

export const DEFAULT_DAYTONA_OBSERVABILITY_VOLUME =
  "harness-claude-observability";
export const DEFAULT_DAYTONA_OBSERVABILITY_MOUNT = "/harness-observability";

export type DaytonaObservabilityBackend = "daytona-volume" | "disabled";

export interface DaytonaObservabilityConfig {
  enabled: boolean;
  backend: DaytonaObservabilityBackend;
  volumeName: string;
  mountPath: string;
}

export interface ClaudeObservabilityPaths {
  runRoot: string;
  attemptRoot: string;
  claudeConfigDir: string;
}

type Environment = Record<string, string | undefined>;

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["0", "false", "off"].includes(value.trim().toLowerCase());
}

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.includes("\0") ||
    !posix.isAbsolute(trimmed)
  ) {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_MOUNT must be an absolute POSIX path",
    );
  }
  const normalized = posix.normalize(trimmed);
  if (normalized === "/") {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_MOUNT must not be the filesystem root",
    );
  }
  return normalized;
}

export function loadDaytonaObservabilityConfig(
  environment: Environment,
): DaytonaObservabilityConfig {
  const volumeName = (
    environment.HARNESS_DAYTONA_OBSERVABILITY_VOLUME ??
      DEFAULT_DAYTONA_OBSERVABILITY_VOLUME
  ).trim();
  if (!volumeName) {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_VOLUME must not be blank",
    );
  }
  const mountPath = normalizeMountPath(
    environment.HARNESS_DAYTONA_OBSERVABILITY_MOUNT ??
      DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  );
  if (isDisabled(environment.HARNESS_DAYTONA_OBSERVABILITY)) {
    return {
      enabled: false,
      backend: "disabled",
      volumeName,
      mountPath,
    };
  }
  return {
    enabled: true,
    backend: "daytona-volume",
    volumeName,
    mountPath,
  };
}

export function buildRunId(
  now = new Date(),
  randomId = randomUUID,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomId().replaceAll("-", "").slice(0, 8)}`;
}

export function claudeObservabilityPaths(
  config: DaytonaObservabilityConfig,
  runId: string,
  attempt: number,
): ClaudeObservabilityPaths {
  if (!config.enabled) {
    throw new Error("Claude observability paths are disabled");
  }
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive safe integer");
  }
  const runRoot = posix.join(config.mountPath, "runs", runId);
  const attemptRoot = posix.join(runRoot, `attempt-${attempt}`);
  return {
    runRoot,
    attemptRoot,
    claudeConfigDir: posix.join(attemptRoot, ".claude"),
  };
}
```

- [ ] **Step 4: Export the observability module**

Modify `src/index.ts` by adding:

```ts
export {
  DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
  buildRunId,
  claudeObservabilityPaths,
  loadDaytonaObservabilityConfig,
  type ClaudeObservabilityPaths,
  type DaytonaObservabilityConfig,
} from "./harness/observability.js";
```

- [ ] **Step 5: Run the targeted test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/observability.test.js
```

Expected: all tests in `dist/test/observability.test.js` pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/harness/observability.ts src/index.ts test/observability.test.ts
git commit -m "feat: add Daytona Claude observability config"
```

## Task 2: V2 Run Manifest Recorder

**Files:**
- Modify: `src/harness/record.ts`
- Modify: `test/observability.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add failing recorder and compatibility tests**

Append these imports to `test/observability.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunRecorder,
  lastRunRecord,
  writeRunRecord,
} from "../src/harness/record.js";
```

Append these tests:

```ts
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
```

- [ ] **Step 2: Run the targeted test and verify it fails on missing exports**

Run:

```bash
npm run build && node --test dist/test/observability.test.js
```

Expected: TypeScript build fails because `createRunRecorder` is not exported.

- [ ] **Step 3: Implement v2 record types and recorder**

Modify `src/harness/record.ts` by keeping the existing v1 functions and adding:

The file already imports `RunOutcome`; keep that import and use
`RunOutcome["report"]["summary"]` for v2 summary types.

Add these types:

```ts
export type RunRecordStatus = "running" | "completed" | "error";

export interface RunRecordObservability {
  enabled: boolean;
  backend: "daytona-volume" | "disabled";
  volumeName: string;
  mountPath: string;
  runRoot?: string;
}

export interface RunRecordEvent {
  at: string;
  event: string;
  data: unknown;
}

export interface RunRecordAttempt {
  attempt: number;
  claudeConfigDir?: string;
  agentSandboxId?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  gateSandboxIds: string[];
  gateOutcome?: string;
}

export interface RunRecordV2 {
  schemaVersion: 2;
  runId: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  driver: string;
  status: RunRecordStatus;
  observability: RunRecordObservability;
  attempts: RunRecordAttempt[];
  events: RunRecordEvent[];
  outcome?: RunOutcome["outcome"];
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  errorReason?: string;
}

export interface CreateRunRecorderInput {
  runId: string;
  createdAt?: string;
  task: string;
  driver: string;
  observability: RunRecordObservability;
}

export interface CompleteRunRecordInput {
  outcome: RunOutcome["outcome"];
  attempts: number;
  summary: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
}
```

Add this class:

```ts
export class RunRecorder {
  readonly path: string;
  private readonly record: RunRecordV2;
  private readonly now: () => string;

  constructor(
    cwd: string,
    input: CreateRunRecorderInput,
    now = () => new Date().toISOString(),
  ) {
    mkdirSync(runsDir(cwd), { recursive: true });
    const createdAt = input.createdAt ?? now();
    this.path = join(runsDir(cwd), `${input.runId}.json`);
    this.now = now;
    this.record = {
      schemaVersion: 2,
      runId: input.runId,
      createdAt,
      updatedAt: createdAt,
      task: input.task,
      driver: input.driver,
      status: "running",
      observability: input.observability,
      attempts: [],
      events: [],
    };
    this.recordEvent("run.record.created", { runId: input.runId });
  }

  recordEvent(event: string, data: unknown): void {
    this.applyEvent(event, data);
    this.record.events.push({ at: this.now(), event, data });
    this.write();
  }

  complete(input: CompleteRunRecordInput): void {
    this.record.status = "completed";
    this.record.outcome = input.outcome;
    this.record.summary = input.summary;
    if (input.action) this.record.action = input.action;
    this.record.updatedAt = this.now();
    this.write();
  }

  fail(error: unknown): void {
    this.record.status = "error";
    this.record.errorReason = error instanceof Error ? error.message : String(error);
    this.record.updatedAt = this.now();
    this.write();
  }

  private attempt(number: number): RunRecordAttempt {
    let attempt = this.record.attempts.find((item) => item.attempt === number);
    if (!attempt) {
      attempt = { attempt: number, gateSandboxIds: [] };
      this.record.attempts.push(attempt);
    }
    return attempt;
  }

  private applyEvent(event: string, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const value = data as Record<string, unknown>;
    const attemptNumber = value.attempt;
    if (!Number.isSafeInteger(attemptNumber) || Number(attemptNumber) <= 0) {
      return;
    }
    const attempt = this.attempt(Number(attemptNumber));
    if (event === "agent.command.start") {
      attempt.startedAt = this.now();
      if (typeof value.id === "string") attempt.agentSandboxId = value.id;
      if (typeof value.claudeConfigDir === "string") {
        attempt.claudeConfigDir = value.claudeConfigDir;
      }
    }
    if (event === "agent.command.end") {
      attempt.endedAt = this.now();
      if (typeof value.exitCode === "number") attempt.exitCode = value.exitCode;
    }
    if (event === "gate.create.end" && typeof value.id === "string") {
      if (!attempt.gateSandboxIds.includes(value.id)) {
        attempt.gateSandboxIds.push(value.id);
      }
    }
    if (event === "gate.run.end" && typeof value.outcome === "string") {
      attempt.gateOutcome = value.outcome;
    }
  }

  private write(): void {
    this.record.updatedAt = this.now();
    writeFileSync(this.path, JSON.stringify(this.record, null, 2), "utf8");
  }
}

export function createRunRecorder(
  cwd: string,
  input: CreateRunRecorderInput,
): RunRecorder {
  return new RunRecorder(cwd, input);
}
```

Update `lastRunRecord()` so it parses v2:

```ts
function toLastRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<RunRecordV2 & RunRecord>;
  if (record.schemaVersion === 2) {
    if (
      typeof record.createdAt !== "string" ||
      typeof record.task !== "string" ||
      typeof record.driver !== "string" ||
      !record.outcome ||
      !record.summary
    ) {
      return undefined;
    }
    return {
      at: record.createdAt,
      task: record.task,
      driver: record.driver,
      outcome: record.outcome,
      attempts: typeof record.attempts === "number"
        ? record.attempts
        : Array.isArray(record.attempts)
        ? record.attempts.length
        : 0,
      summary: record.summary,
      ...(record.action ? { action: record.action } : {}),
    };
  }
  return record as RunRecord;
}
```

Use `toLastRunRecord(JSON.parse(...))` inside `lastRunRecord()`.

- [ ] **Step 4: Export recorder APIs**

Modify `src/index.ts` export from `./harness/record.js` to include:

```ts
export {
  createRunRecorder,
  lastRunRecord,
  writeRunRecord,
  type CompleteRunRecordInput,
  type CreateRunRecorderInput,
  type RunRecord,
  type RunRecordAttempt,
  type RunRecordEvent,
  type RunRecordObservability,
  type RunRecordV2,
} from "./harness/record.js";
```

- [ ] **Step 5: Run the targeted test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/observability.test.js
```

Expected: all observability tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/harness/record.ts src/index.ts test/observability.test.ts
git commit -m "feat: add incremental run observability records"
```

## Task 3: Daytona Volume Mount Support

**Files:**
- Modify: `src/harness/sandbox/types.ts`
- Modify: `src/harness/sandbox/daytona.ts`
- Modify: `test/daytona-sandbox.test.ts`

- [ ] **Step 1: Write failing provider tests for volume resolution and mapping**

Modify `test/daytona-sandbox.test.ts`:

Add `volumes` to `CreateRequest` and `CreatedSdkRequest`:

```ts
interface CreateRequest {
  role: "agent" | "gate";
  snapshot?: string;
  envVars: Record<string, string>;
  ephemeral: boolean;
  volumes?: Array<{ volumeId: string; mountPath: string }>;
}

interface CreatedSdkRequest {
  language?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  ephemeral?: boolean;
  networkBlockAll?: boolean;
  volumes?: Array<{ volumeId: string; mountPath: string }>;
}
```

Add tests after `SDK provider maps role, environment, and lifecycle fields into create`:

```ts
test("SDK provider resolves requested volumes before sandbox creation", async () => {
  const created: CreatedSdkRequest[] = [];
  const volumeGets: Array<{ name: string; create: boolean | undefined }> = [];
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient({
    volume: {
      async get(name: string, create?: boolean) {
        volumeGets.push({ name, create });
        return { id: "volume-123", name, __brand: "Volume" as const };
      },
    },
    async create(request: CreatedSdkRequest) {
      created.push(request);
      return sdkSandbox;
    },
    async delete() {
      sdkSandbox.calls.deleted++;
    },
  });

  await provider.create({
    role: "agent",
    snapshot: "harness-agent-claude-latest",
    envVars: {},
    ephemeral: false,
    volumes: [{
      volumeId: "harness-claude-observability",
      mountPath: "/harness-observability",
    }],
  });

  assert.deepEqual(volumeGets, [{
    name: "harness-claude-observability",
    create: true,
  }]);
  assert.deepEqual(created[0]?.volumes, [{
    volumeId: "volume-123",
    mountPath: "/harness-observability",
  }]);
});

test("SDK provider fails closed when volume service is missing for a volume request", async () => {
  const created: CreatedSdkRequest[] = [];
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient({
    async create(request: CreatedSdkRequest) {
      created.push(request);
      return sdkSandbox;
    },
    async delete() {
      sdkSandbox.calls.deleted++;
    },
  });

  await assert.rejects(
    () =>
      provider.create({
        role: "agent",
        envVars: {},
        ephemeral: false,
        volumes: [{
          volumeId: "harness-claude-observability",
          mountPath: "/harness-observability",
        }],
      }),
    /Daytona volume service is required/,
  );
  assert.deepEqual(created, []);
});
```

- [ ] **Step 2: Run the targeted test and verify it fails on missing `volumes` typing**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js
```

Expected: TypeScript build fails because `SandboxCreateRequest` and
`DaytonaSdkClient` do not accept `volumes`.

- [ ] **Step 3: Add volume mount types**

Modify `src/harness/sandbox/types.ts`:

```ts
export interface SandboxVolumeMount {
  volumeId: string;
  mountPath: string;
}

interface SandboxCreateBaseRequest {
  envVars: Record<string, string>;
  ephemeral: boolean;
  volumes?: SandboxVolumeMount[];
}
```

- [ ] **Step 4: Add Daytona volume service support**

Modify imports in `src/harness/sandbox/daytona.ts`:

```ts
import type { Volume } from "@daytona/sdk";
```

Add interfaces near `DaytonaSdkClient`:

```ts
export interface DaytonaVolumeService {
  get(name: string, create?: boolean): Promise<Pick<Volume, "id" | "name">>;
}
```

Extend `DaytonaSdkClient.create()` params with:

```ts
volumes?: Array<{ volumeId: string; mountPath: string }>;
```

Extend `DaytonaSdkClient` with:

```ts
volume?: DaytonaVolumeService;
```

Add provider helper:

```ts
async function resolveVolumeMounts(
  volumeService: DaytonaVolumeService | undefined,
  mounts: Array<{ volumeId: string; mountPath: string }> | undefined,
): Promise<Array<{ volumeId: string; mountPath: string }> | undefined> {
  if (!mounts || mounts.length === 0) return undefined;
  if (!volumeService) {
    throw new Error("Daytona volume service is required for volume mounts");
  }
  const resolved = [];
  for (const mount of mounts) {
    const volume = await volumeService.get(mount.volumeId, true);
    resolved.push({ volumeId: volume.id, mountPath: mount.mountPath });
  }
  return resolved;
}
```

Update `DaytonaSdkProvider.create()`:

```ts
const volumes = await resolveVolumeMounts(
  this.client.volume,
  request.volumes,
);
const sandbox = await this.client.create({
  language: "typescript",
  ...(snapshot ? { snapshot } : {}),
  labels: { "harness.role": request.role },
  envVars: request.envVars,
  ephemeral: request.ephemeral,
  networkBlockAll: false,
  ...(volumes ? { volumes } : {}),
});
```

- [ ] **Step 5: Update existing daytona sandbox test expectations**

In `test/daytona-sandbox.test.ts`, update expected created requests to include
no `volumes` property when no volumes are requested. Do not add
`volumes: undefined` to expected objects.

- [ ] **Step 6: Run the targeted test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js
```

Expected: all Daytona sandbox adapter tests pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/harness/sandbox/types.ts src/harness/sandbox/daytona.ts test/daytona-sandbox.test.ts
git commit -m "feat: support Daytona observability volume mounts"
```

## Task 4: Inject Claude Artifact Paths Into Daytona Agent Runs

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing environment test for Agent-only volume and Claude env**

Modify `test/daytona-environment.test.ts`:

Add import:

```ts
import { loadDaytonaObservabilityConfig } from "../src/harness/observability.js";
```

Add this test after `gate sandboxes use Gate runtime snapshots without model credentials or Claude installation`:

```ts
test("Claude Daytona observability mounts only the Agent sandbox and sets CLAUDE_CONFIG_DIR", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-obs",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });
  await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });
  await environment.close();

  const agentRequest = provider.requests.find(
    (request) => request.role === "agent",
  );
  const gateRequest = provider.requests.find(
    (request) => request.role === "gate",
  );
  assert.deepEqual(agentRequest?.volumes, [{
    volumeId: "harness-claude-observability",
    mountPath: "/harness-observability",
  }]);
  assert.equal(gateRequest?.volumes, undefined);

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  const mkdirCall = agent.executeCalls.find((call) =>
    call.command === 'mkdir -p "$CLAUDE_CONFIG_DIR"'
  );
  assert.equal(mkdirCall?.env.CLAUDE_CONFIG_DIR, "/harness-observability/runs/run-obs/attempt-1/.claude");
  assert.equal(mkdirCall?.timeoutMs, 30_000);

  const claudeCall = agent.executeCalls.find((call) =>
    call.command === CLAUDE_COMMAND
  );
  assert.equal(claudeCall?.env.CLAUDE_CONFIG_DIR, "/harness-observability/runs/run-obs/attempt-1/.claude");
  assert.equal(claudeCall?.env.HARNESS_RUN_ID, "run-obs");
  assert.equal(claudeCall?.env.HARNESS_ATTEMPT, "1");
  assert.equal(claudeCall?.env.HARNESS_OBSERVABILITY_RUN_ROOT, "/harness-observability/runs/run-obs");
  assert.equal(claudeCall?.env.HARNESS_OBSERVABILITY_ATTEMPT_ROOT, "/harness-observability/runs/run-obs/attempt-1");

  const commandStart = observations.find(([event]) =>
    event === "agent.command.start"
  );
  assert.equal((commandStart?.[1] as { attempt?: number }).attempt, 1);
  assert.equal(
    (commandStart?.[1] as { claudeConfigDir?: string }).claudeConfigDir,
    "/harness-observability/runs/run-obs/attempt-1/.claude",
  );
});
```

- [ ] **Step 2: Run the targeted test and verify it fails on missing `observability` option**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js
```

Expected: TypeScript build fails because `DaytonaRunEnvironmentOptions` does
not accept `observability`.

- [ ] **Step 3: Add observability option types**

Modify imports in `src/harness/sandbox/environment.ts`:

```ts
import {
  claudeObservabilityPaths,
  type DaytonaObservabilityConfig,
} from "../observability.js";
```

Add:

```ts
export interface DaytonaRunObservabilityOptions {
  runId: string;
  config: DaytonaObservabilityConfig;
}
```

Extend `DaytonaRunEnvironmentOptions`:

```ts
observability?: DaytonaRunObservabilityOptions;
```

- [ ] **Step 4: Mount the volume only for Claude Agent sandboxes**

Inside `createDaytonaRunEnvironment()`, define:

```ts
const observability = options.agent.kind === "claude"
  ? options.observability
  : undefined;
const observabilityVolumes = observability?.config.enabled
  ? [{
    volumeId: observability.config.volumeName,
    mountPath: observability.config.mountPath,
  }]
  : undefined;
```

Update the Agent create request:

```ts
const handle = await options.provider.create({
  role: "agent",
  ...(agentSnapshot ? { snapshot: agentSnapshot } : {}),
  envVars: {},
  ephemeral: false,
  ...(observabilityVolumes ? { volumes: observabilityVolumes } : {}),
});
```

Do not modify Gate create requests.

- [ ] **Step 5: Prepare attempt directory and inject Claude env**

Add state near existing `published` and `closed` variables:

```ts
let agentAttempt = 0;
```

Add helper:

```ts
async function prepareClaudeObservability(
  handle: SandboxHandle,
  runId: string,
  attempt: number,
  config: DaytonaObservabilityConfig,
): Promise<Record<string, string>> {
  if (!config.enabled) return {};
  const paths = claudeObservabilityPaths(config, runId, attempt);
  await handle.execute(
    'mkdir -p "$CLAUDE_CONFIG_DIR"',
    REMOTE_ROOT,
    { CLAUDE_CONFIG_DIR: paths.claudeConfigDir },
    30_000,
  );
  return {
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    HARNESS_RUN_ID: runId,
    HARNESS_ATTEMPT: String(attempt),
    HARNESS_OBSERVABILITY_RUN_ROOT: paths.runRoot,
    HARNESS_OBSERVABILITY_ATTEMPT_ROOT: paths.attemptRoot,
  };
}
```

In `runTask()`, increment attempt before running the command:

```ts
agentAttempt++;
const attempt = agentAttempt;
```

Before `observe("agent.command.start", ...)` in the Claude branch, compute:

```ts
const claudeObservationEnv = observability
  ? await prepareClaudeObservability(
    handle,
    observability.runId,
    attempt,
    observability.config,
  )
  : {};
const claudeConfigDir = claudeObservationEnv.CLAUDE_CONFIG_DIR;
```

Change start/end observations:

```ts
observe("agent.command.start", {
  id: handle.id,
  attempt,
  ...(claudeConfigDir ? { claudeConfigDir } : {}),
});
```

and:

```ts
observe("agent.command.end", {
  id: handle.id,
  attempt,
  exitCode: result.exitCode,
  durationMs: durationSince(commandStartedAt),
});
```

Pass env to Claude:

```ts
{ ...modelEnvironment, ...claudeObservationEnv, HARNESS_PROMPT: prompt }
```

For command agents, keep the existing env and include `attempt` in observation
events without `CLAUDE_CONFIG_DIR`.

- [ ] **Step 6: Include attempt in Gate observations**

In `runGate()`, set:

```ts
const attempt = Math.max(agentAttempt, 1);
```

Add `attempt` to `gate.create.end`, `gate.run.end`, and `gate.cleanup.end`
event data. Do not add candidate bytes, prompt text, or model credentials.

- [ ] **Step 7: Run the targeted test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/daytona-environment.test.js
```

Expected: all Daytona environment tests pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/harness/sandbox/environment.ts test/daytona-environment.test.ts
git commit -m "feat: persist Claude config into Agent observability volume"
```

## Task 5: CLI Run Recorder Wiring

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/frozen-contract-callers.test.ts`

- [ ] **Step 1: Write failing CLI test for pre-agent v2 record on Daytona Claude configuration failure**

Modify imports in `test/frozen-contract-callers.test.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
```

Replace the current `node:fs` import with one import containing:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
```

Append to `CLI claude run requires Daytona and never falls back to host execution`:

```ts
  const runsDir = join(cwd, ".harness", "runs");
  assert.equal(existsSync(runsDir), true);
  const runFiles = readdirSync(runsDir).filter((file) => file.endsWith(".json"));
  assert.equal(runFiles.length, 1);
  const record = JSON.parse(
    readFileSync(join(runsDir, runFiles[0]!), "utf8"),
  );
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "error");
  assert.equal(record.task, "test task");
  assert.equal(record.driver, "daytona(claude)");
  assert.equal(record.observability.enabled, true);
  assert.match(record.errorReason, /DAYTONA_API_KEY/);
```

- [ ] **Step 2: Run the CLI test and verify it fails because no run record is written**

Run:

```bash
npm run build && node --test dist/test/frozen-contract-callers.test.js
```

Expected: the CLI Claude test fails because `.harness/runs` does not exist.

- [ ] **Step 3: Wire recorder creation in `src/cli.ts`**

Modify imports:

```ts
import {
  buildRunId,
  claudeObservabilityPaths,
  loadDaytonaObservabilityConfig,
} from "./harness/observability.js";
import {
  createRunRecorder,
  writeRunRecord,
  type RunRecord,
  type RunRecorder,
} from "./harness/record.js";
```

Use the actual exported `RunRecorder` type name from Task 2.

Inside `doRun()`, after `agent = selectAgent(values)` and before
`createDaytonaRunEnvironment()`, add:

```ts
let recorder: RunRecorder | undefined;
let observability:
  | { runId: string; config: ReturnType<typeof loadDaytonaObservabilityConfig> }
  | undefined;

if (agent.kind === "claude") {
  const runId = buildRunId();
  const config = loadDaytonaObservabilityConfig(process.env);
  observability = { runId, config };
  const runRoot = config.enabled
    ? claudeObservabilityPaths(config, runId, 1).runRoot
    : undefined;
  recorder = createRunRecorder(cwd, {
    runId,
    task,
    driver: "daytona(claude)",
    observability: {
      enabled: config.enabled,
      backend: config.backend,
      volumeName: config.volumeName,
      mountPath: config.mountPath,
      ...(runRoot ? { runRoot } : {}),
    },
  });
}
```

Pass `observability` to `createDaytonaRunEnvironment()`:

```ts
observability,
```

Update `onObservation`:

```ts
onObservation(event, data) {
  recorder?.recordEvent(event, data);
  console.log(
    `    · ${event}: ${JSON.stringify(redactObservationData(data))}`,
  );
},
```

Wrap `runLoop()`:

```ts
let outcome;
try {
  outcome = await runLoop({
    task,
    contracts: selected,
    gate,
    ctx,
    environment,
    budget,
    ...(initialFeedback ? { initialFeedback } : {}),
    onLog: (l) => console.log(l),
  });
} catch (error) {
  recorder?.fail(error);
  throw error;
}
```

Replace final record writing with:

```ts
let recPath: string;
if (recorder) {
  recorder.complete({
    outcome: outcome.outcome,
    attempts: outcome.attempts,
    summary: outcome.report.summary,
    ...(outcome.action ? { action: outcome.action } : {}),
  });
  recPath = recorder.path;
} else {
  const rec: RunRecord = {
    at: new Date().toISOString(),
    task,
    driver: environment.name,
    outcome: outcome.outcome,
    attempts: outcome.attempts,
    summary: outcome.report.summary,
    ...(outcome.action ? { action: outcome.action } : {}),
  };
  recPath = writeRunRecord(cwd, rec);
}
```

- [ ] **Step 4: Run the CLI test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/frozen-contract-callers.test.js
```

Expected: all frozen contract caller tests pass, and the Claude Daytona
configuration failure writes a v2 manifest with `status: "error"`.

- [ ] **Step 5: Run related targeted tests**

Run:

```bash
node --test dist/test/observability.test.js dist/test/daytona-environment.test.js
```

Expected: both test files pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/cli.ts test/frozen-contract-callers.test.ts
git commit -m "feat: record Daytona Claude run manifests from CLI"
```

## Task 6: Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `docs/daytona-local-claude-code-runbook.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`
- Modify: `docs/architecture/daytona-langfuse-observability.md`

- [ ] **Step 1: Update README**

Add this paragraph under the run command block in `README.md`:

```md
Daytona Claude runs persist Claude Code artifacts by default. Harness mounts
the Daytona volume `harness-claude-observability` into the Agent sandbox at
`/harness-observability` and sets `CLAUDE_CONFIG_DIR` to
`/harness-observability/runs/<runId>/attempt-<n>/.claude`. The host run record
under `.harness/runs/<runId>.json` points to that directory. These artifacts
are raw Claude Code data and are not redacted.
```

- [ ] **Step 2: Update runbook required environment**

Add to `docs/daytona-local-claude-code-runbook.md` after Snapshot env vars:

```bash
export HARNESS_DAYTONA_OBSERVABILITY_VOLUME="harness-claude-observability" # optional default
export HARNESS_DAYTONA_OBSERVABILITY_MOUNT="/harness-observability" # optional default
```

Add this inspection section:

```md
## Claude Artifact Persistence

`harness run --driver claude` writes a v2 run record before the Agent command
starts. The record lives under `.harness/runs/<runId>.json` and includes:

- Daytona Agent sandbox id;
- Gate sandbox ids;
- Daytona observability volume name;
- mounted run root;
- attempt-scoped `CLAUDE_CONFIG_DIR`;
- command exit code and gate outcome.

The default Claude artifact path in the Agent sandbox is:

```text
/harness-observability/runs/<runId>/attempt-<n>/.claude
```

The Daytona volume survives sandbox deletion. Treat the volume as sensitive
because Claude Code transcripts can contain prompt text, source code, command
output, tool results, and secrets printed by tools.
```

- [ ] **Step 3: Update architecture doc**

Add to `docs/architecture/daytona-sandbox-gate.md` data ownership table:

```md
| Claude `.claude` artifacts | Agent sandbox / Claude Code | Operator inspection through Daytona volume and host run record | Raw sensitive log data |
```

Add a paragraph near Agent sandbox lifecycle:

```md
For Claude Agent runs, Harness mounts the Agent-only Daytona volume
`harness-claude-observability` at `/harness-observability` and sets
`CLAUDE_CONFIG_DIR` to a run/attempt path under that mount. Gate sandboxes do
not receive this volume. The host `.harness/runs/<runId>.json` manifest is the
lookup index that links task, sandbox ids, attempts, gate outcomes, and the
Claude artifact path.
```

- [ ] **Step 4: Update Langfuse observability doc**

Add to `docs/architecture/daytona-langfuse-observability.md` after section 2:

```md
## 2.1 当前默认补偿：`.claude` 持久化

Daytona Claude 路径默认不把 Langfuse 密钥注入 Agent 沙箱，也不通过 host
OpenTelemetry 包住远端 CLI。为了补齐事后排障，Harness 默认把 Claude Code 的
`CLAUDE_CONFIG_DIR` 指向 Agent-only Daytona 持久卷：

```text
/harness-observability/runs/<runId>/attempt-<n>/.claude
```

host 侧 `.harness/runs/<runId>.json` 记录任务、sandbox id、attempt、Gate
结果和上述路径。这个机制是 artifact persistence，不是 Langfuse SDK tracing。
它保留原始 Claude Code transcript 和 sidecar 文件，不做脱敏。
```

- [ ] **Step 5: Run documentation diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Commit**

Run:

```bash
git add README.md docs/daytona-local-claude-code-runbook.md docs/architecture/daytona-sandbox-gate.md docs/architecture/daytona-langfuse-observability.md
git commit -m "docs: document Daytona Claude artifact persistence"
```

## Task 7: Full Verification

**Files:**
- No planned source edits unless verification exposes a defect.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm run build && node --test \
  dist/test/observability.test.js \
  dist/test/daytona-sandbox.test.js \
  dist/test/daytona-environment.test.js \
  dist/test/frozen-contract-callers.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full package check**

Run:

```bash
npm run check
```

Expected: `node --test "dist/test/**/*.test.js"` reports zero failures. In this
Codex environment, localhost-binding tests may require unrestricted execution;
if `listen EPERM 127.0.0.1` appears, rerun the same command in the unrestricted
environment and report both outputs.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git diff --stat main...HEAD
git diff --check
```

Expected: only planned files changed, and `git diff --check` reports no
whitespace errors.

- [ ] **Step 4: Commit any verification fixes**

If verification required source or test fixes, commit them:

```bash
git add src/harness/observability.ts src/harness/record.ts src/harness/sandbox/types.ts src/harness/sandbox/daytona.ts src/harness/sandbox/environment.ts src/cli.ts src/index.ts test/observability.test.ts test/daytona-sandbox.test.ts test/daytona-environment.test.ts test/frozen-contract-callers.test.ts README.md docs/daytona-local-claude-code-runbook.md docs/architecture/daytona-sandbox-gate.md docs/architecture/daytona-langfuse-observability.md
git commit -m "fix: stabilize Daytona Claude observability persistence"
```

Skip this step if no fixes were needed.

## Self-Review Checklist

- Spec coverage:
  - Default-on Daytona Claude `.claude` persistence: Tasks 1, 4, 5.
  - Host manifest before Agent execution: Tasks 2 and 5.
  - Daytona volume create/resolve and Agent-only mount: Tasks 3 and 4.
  - Attempt-scoped `CLAUDE_CONFIG_DIR`: Task 4.
  - Gate sandbox exclusion: Task 4.
  - Raw unredacted artifact policy and docs: Tasks 2 and 6.
  - Disabled operational recovery mode: Tasks 1 and 2.
  - v1 record compatibility: Task 2.

- Placeholder scan:
  - No task uses open-ended implementation phrases.
  - Every code change has a concrete file and test command.

- Type consistency:
  - `DaytonaObservabilityConfig` is produced by `loadDaytonaObservabilityConfig()`.
  - `DaytonaRunObservabilityOptions` passes `{ runId, config }`.
  - `SandboxVolumeMount` uses `{ volumeId, mountPath }`, matching Daytona SDK.
  - `RunRecorder` writes v2 records and `lastRunRecord()` returns legacy-compatible summaries.

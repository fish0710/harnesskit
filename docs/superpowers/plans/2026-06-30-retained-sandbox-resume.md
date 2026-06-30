# Retained Sandbox Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit CLI path that resumes an escalated Claude run from a retained Daytona Agent sandbox, validates the existing candidate with the current Gate first, and only asks Claude to continue if the candidate still fails.

**Architecture:** Keep normal `harness run` semantics unchanged. Add an explicit `harness runs resume <runId>` command that validates the original run record, attaches to the retained Agent sandbox, seeds the previous Claude session and attempt number, runs Gate against the preserved candidate before any new agent command, then publishes or continues with `claude --resume`. For series-task runs, a successful resume updates the series ledger to `ready_to_commit` so the existing series resume path can commit or continue.

**Tech Stack:** TypeScript, Node `node:test`, existing Daytona SDK provider abstraction, RunStore v3 records, existing sandbox collector/publisher, existing task series ledger.

---

## Current Behavior

- `runLoop()` always starts with `environment.runTask()`, then `environment.runGate()`.
- Daytona Claude retries inside one live run already resume with `claude --resume <sessionId>` in the same Agent sandbox.
- `retainOnFailure: true` prevents `close()` from deleting the Agent sandbox after an unpublished failure, but there is no CLI path that attaches to that retained sandbox later.
- `SandboxProvider` only exposes `create()`. The Daytona SDK already exposes `get(id)`, but Harness does not surface it.
- RunStore attempts already contain `agentSandboxId` and `claudeSessionId`.
- Series ledger terminal statuses `blocked`, `escalated`, and `error` stop normal series resume.

## Recommended Scope

Implement explicit resume only for `daytona(claude)` runs whose original outcome is `escalated`. Do not make ordinary `harness run` silently attach to old sandboxes. Do not support command-driver resume in this pass because command drivers do not have a durable session contract equivalent to Claude's session id.

The resume path should be conservative:

- Require current Git `HEAD` to match the original RunStore `repo.head`.
- Refuse if the original run started dirty, because Harness cannot reconstruct the exact baseline snapshot from RunStore.
- Require the current worktree to be clean outside `.harness`.
- Require a retained `agentSandboxId`.
- Refuse if the original record contains `agent.cleanup.end` with `outcome: "deleted"` for that sandbox id.
- Prefer a Gate-first resume: collect the candidate already in the retained sandbox, run Gate, and publish immediately if Gate now passes.
- If Gate still fails, run one or more additional Claude attempts using `claude --resume <sessionId>`.
- Force `retainOnFailure: true` for the resume environment so a second failed resume does not destroy the preserved work.

## Files

- Modify: `src/harness/sandbox/types.ts`
  Add an optional attach capability to sandbox providers.
- Modify: `src/harness/sandbox/daytona.ts`
  Add `get()` to the typed Daytona client and implement provider attach using `daytona.get(id)`.
- Modify: `src/harness/sandbox/environment.ts`
  Add retained Agent attach options, seed Claude resume state, skip Agent bootstrap on attach, and preserve retained cleanup semantics.
- Modify: `src/harness/run.ts`
  Add a Gate-first loop option for retained candidates without changing default run behavior.
- Create: `src/harness/resume.ts`
  Add run-record validation and resume request construction helpers.
- Modify: `src/harness/series.ts`
  Add a helper that marks a resumed series task as `ready_to_commit` after publish.
- Modify: `src/cli.ts`
  Add `harness runs resume <runId>` and route it through the existing run setup pieces.
- Modify: `docs/usage.md`
  Document retained sandbox resume and its safety constraints.
- Modify: `docs/daytona-local-claude-code-runbook.md`
  Document operational recovery steps.
- Test: `test/daytona-sandbox.test.ts`
  Provider attach coverage.
- Test: `test/daytona-environment.test.ts`
  Retained attach, Gate-first publish, and continued Claude resume coverage.
- Test: `test/run-loop.test.ts`
  Gate-first run loop behavior.
- Test: `test/resume.test.ts`
  Resume validation helper coverage.
- Test: `test/harness-series.test.ts`
  Series ledger ready-to-commit update helper coverage.
- Test: `test/cli.test.ts`
  CLI validation and help text coverage.

---

### Task 1: Add Sandbox Provider Attach Surface

**Files:**
- Modify: `src/harness/sandbox/types.ts`
- Modify: `src/harness/sandbox/daytona.ts`
- Test: `test/daytona-sandbox.test.ts`

- [ ] **Step 1: Write failing provider attach tests**

Append this test near the SDK provider tests in `test/daytona-sandbox.test.ts`:

```ts
test("SDK provider attaches to an existing sandbox by id", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const calls = { get: [] as string[] };
  const provider = createDaytonaSdkProviderFromClient({
    ...fakeSdkClient(sdkSandbox),
    async get(id: string) {
      calls.get.push(id);
      return sdkSandbox;
    },
  });

  const attached = await provider.attach("sandbox-retained-123");

  assert.equal(attached.id, "sdk-sandbox");
  assert.deepEqual(calls.get, ["sandbox-retained-123"]);
});

test("SDK provider rejects unsafe attach ids", async () => {
  const provider = createDaytonaSdkProviderFromClient({
    ...fakeSdkClient(fakeSdkSandbox()),
    async get() {
      throw new Error("get should not be called");
    },
  });

  await assert.rejects(
    () => provider.attach("../sandbox"),
    /sandbox id must be a non-empty safe path segment/,
  );
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npm run build
node --test dist/test/daytona-sandbox.test.js --test-name-pattern "SDK provider attaches|SDK provider rejects unsafe attach ids"
```

Expected: TypeScript build fails because `attach` and `get` do not exist on the typed interfaces.

- [ ] **Step 3: Add attach types**

In `src/harness/sandbox/types.ts`, replace the provider interface with this:

```ts
export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  attach?(sandboxId: string): Promise<SandboxHandle>;
}
```

In `src/harness/sandbox/daytona.ts`, extend `DaytonaSdkClient`:

```ts
export interface DaytonaSdkClient {
  readonly volume?: DaytonaVolumeService;
  create(params: {
    language: string;
    snapshot?: string;
    labels: Record<string, string>;
    envVars: Record<string, string>;
    ephemeral: boolean;
    networkBlockAll: boolean;
    volumes?: VolumeMount[];
  }): Promise<DaytonaSdkSandbox>;
  get(sandboxIdOrName: string): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
}
```

Add this helper near `assertSafeRunId`-style validation helpers in `src/harness/sandbox/daytona.ts`:

```ts
function assertSafeSandboxId(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("sandbox id must be a non-empty safe path segment");
  }
  return value;
}
```

Add this method to `DaytonaSdkProvider`:

```ts
  async attach(sandboxId: string): Promise<SandboxHandle> {
    const sandbox = await this.client.get(assertSafeSandboxId(sandboxId));
    if (this.apiUrl) rewriteRemoteToolboxProxy(sandbox, this.apiUrl);
    return new DaytonaSandboxHandle(this.client, sandbox);
  }
```

- [ ] **Step 4: Update fake clients that implement `DaytonaSdkClient`**

In `test/daytona-sandbox.test.ts`, update `fakeSdkClient()`:

```ts
function fakeSdkClient(sandbox: ReturnType<typeof fakeSdkSandbox>) {
  return {
    async create() {
      return sandbox;
    },
    async get() {
      return sandbox;
    },
    async delete() {
      sandbox.calls.deleted++;
    },
  };
}
```

For any other test fake that now fails TypeScript because it lacks `get`, add:

```ts
async get() {
  return sandbox;
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build
node --test dist/test/daytona-sandbox.test.js --test-name-pattern "SDK provider attaches|SDK provider rejects unsafe attach ids"
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/sandbox/types.ts src/harness/sandbox/daytona.ts test/daytona-sandbox.test.ts
git commit -m "feat: attach to retained Daytona sandboxes"
```

---

### Task 2: Add Gate-First Run Loop Support

**Files:**
- Modify: `src/harness/run.ts`
- Test: `test/run-loop.test.ts`

- [ ] **Step 1: Write failing Gate-first tests**

Append these tests to `test/run-loop.test.ts`:

```ts
test("runLoop can validate a retained candidate before running the agent", async () => {
  const calls: string[] = [];
  const environment: RunEnvironment = {
    name: "retained-test",
    async runTask() {
      calls.push("task");
      return { summary: "agent should not run", changedFiles: [] };
    },
    async runGate() {
      calls.push("gate");
      return passReport();
    },
    async publish() {
      calls.push("publish");
      return { ok: true, changedFiles: ["src/a.ts"] };
    },
    async close() {
      calls.push("close");
    },
  };

  const outcome = await runLoop({
    task: "resume retained candidate",
    contracts: [],
    gate: new GateCore(),
    ctx: { cwd: process.cwd() },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.deepEqual(calls, ["gate", "publish", "close"]);
});

test("runLoop feeds retained Gate diagnostics to the next agent attempt", async () => {
  const calls: string[] = [];
  const environment: RunEnvironment = {
    name: "retained-test",
    async runTask(input) {
      calls.push(`task:${input.feedback?.includes("fix retained") ? "feedback" : "missing"}`);
      return { summary: "agent fixed candidate", changedFiles: ["src/a.ts"] };
    },
    async runGate() {
      calls.push("gate");
      return calls.filter((call) => call === "gate").length === 1
        ? failReport("fix retained")
        : passReport();
    },
    async publish() {
      calls.push("publish");
      return { ok: true, changedFiles: ["src/a.ts"] };
    },
    async close() {
      calls.push("close");
    },
  };

  const outcome = await runLoop({
    task: "resume retained candidate",
    contracts: [],
    gate: new GateCore(),
    ctx: { cwd: process.cwd() },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.deepEqual(calls, ["gate", "task:feedback", "gate", "publish", "close"]);
});
```

If `passReport()`, `failReport()`, `budget`, or `RunEnvironment` are not already imported in this test file, use the same helper shapes already present in the file. The failing assertion must prove that `runTask()` is skipped when the retained candidate passes.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm run build
node --test dist/test/run-loop.test.js --test-name-pattern "retained candidate|retained Gate diagnostics"
```

Expected: build fails because `RunOptions` does not have `startWithGate`, or runtime fails because the loop still calls `runTask()` first.

- [ ] **Step 3: Add `startWithGate` to `RunOptions`**

In `src/harness/run.ts`, add:

```ts
  startWithGate?: boolean;
```

to `RunOptions`.

- [ ] **Step 4: Extract Gate evaluation inside `runLoop`**

Inside `runLoop()`, add this local helper after `const hardCap = Math.max(...)`:

```ts
  const runGateAndMaybePublish = async (attempt: number): Promise<RunOutcome | undefined> => {
    o.diagnosticLog?.debug("loop", "gate run start", {
      attempt,
      contracts: o.contracts.map((contract) => contract.id),
    });
    const report = await o.environment.runGate({
      contracts: o.contracts,
      gate: o.gate,
      ctx: o.ctx,
    });
    o.diagnosticLog?.debug("loop", "gate run end", {
      attempt,
      outcome: report.outcome,
      summary: report.summary,
    });
    log(`  门禁: ${report.outcome}(pass ${report.summary.pass}/${report.summary.total}, fail ${report.summary.fail}, error ${report.summary.error}, review ${report.summary.needsReview})`);

    if (report.outcome === "pass") {
      o.diagnosticLog?.debug("loop", "publish start", { attempt });
      const publication = await o.environment.publish();
      o.diagnosticLog?.debug("loop", "publish end", { attempt, publication });
      if (!publication.ok) {
        const action = {
          kind: "stop_for_human" as const,
          reason: publication.conflict ?? "候选发布失败",
        };
        log(`  发布失败,升级: ${action.reason}`);
        return {
          outcome: "escalated",
          attempts: state.attempts,
          report,
          action,
          publication,
          logs,
        };
      }
      log("  ✓ 就绪:可开 MR(注意:绿不算放行,合入裁决在 CI 隔离环境)");
      return {
        outcome: "ready_for_mr",
        attempts: state.attempts,
        report,
        publication,
        logs,
      };
    }

    if (report.outcome === "blocked") {
      log("  ◐ 有待人工决策项,停下 → 运行 `harness review`");
      return { outcome: "blocked", attempts: state.attempts, report, logs };
    }

    updateStreaks(state, report);
    state.elapsedMs = performance.now() - startedAt;
    state.contextUsedRatio = o.contextUsedRatio?.() ?? 0;
    const action = decideEscalation(state);
    if (action.kind !== "continue") {
      o.diagnosticLog?.warn("loop", "escalation selected", { attempt, action });
      log(`  升级: ${action.kind} — ${action.reason}`);
      return { outcome: "escalated", attempts: state.attempts, report, action, logs };
    }
    if (state.attempts >= hardCap) {
      o.diagnosticLog?.warn("loop", "hard cap reached", { attempt, hardCap });
      log(`  达到硬上限 ${hardCap} 轮,停下交人`);
      return {
        outcome: "escalated",
        attempts: state.attempts,
        report,
        action: { kind: "stop_for_human", reason: `达到硬上限 ${hardCap} 轮` },
        logs,
      };
    }

    feedback = diagnostics(report);
    o.diagnosticLog?.debug("loop", "diagnostics feedback generated", {
      attempt,
      feedbackBytes: Buffer.byteLength(feedback),
    });
    log("  未通过 → 把诊断反馈给 driver,重试");
    return undefined;
  };
```

Then at the start of the `try` block, before `while (true)`, add:

```ts
    if (o.startWithGate) {
      log(`恢复校验 · environment=${o.environment.name}`);
      const retainedOutcome = await runGateAndMaybePublish(0);
      if (retainedOutcome) return retainedOutcome;
    }
```

Replace the duplicated Gate/publish/escalation block inside the loop with:

```ts
      const outcome = await runGateAndMaybePublish(state.attempts);
      if (outcome) return outcome;
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build
node --test dist/test/run-loop.test.js --test-name-pattern "retained candidate|retained Gate diagnostics"
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/run.ts test/run-loop.test.ts
git commit -m "feat: validate retained candidates before rerunning agents"
```

---

### Task 3: Attach Retained Agent Sandbox in Daytona Environment

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Test: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing retained attach tests**

Add this test near the existing Claude resume tests in `test/daytona-environment.test.ts`:

```ts
test("retained Daytona resume attaches to the existing agent and publishes if Gate now passes", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [],
  });
  const retained = provider.handles[0] ?? new RecordingHandle("agent", "retained-agent");
  retained.files.set("src/a.ts", workspaceFile("src/a.ts", "fixed\n"));
  provider.attachHandle = retained;
  const observations: Array<[string, unknown]> = [];

  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: { ...policy(), retainOnFailure: true },
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeSessionId: "session-abc",
      completedAttempts: 3,
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "resume retained",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(provider.requests.filter((request) => request.role === "agent").length, 0);
  assert.equal(provider.attachedIds[0], "retained-agent");
  assert.equal(provider.claudeRuns, 0);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "fixed\n");
  assert.equal(retained.deleted, true);
  assert.deepEqual(
    observations.filter(([event]) => event === "agent.attach.end").map(([, data]) => (data as { id?: string }).id),
    ["retained-agent"],
  );
});
```

Add this test after it:

```ts
test("retained Daytona resume continues Claude with the captured session when Gate still fails", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["still-broken\n", "fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-abc" }),
    ],
  });
  const retained = new RecordingHandle("agent", "retained-agent");
  retained.files.set("src/a.ts", workspaceFile("src/a.ts", "still-broken\n"));
  provider.attachHandle = retained;

  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: { ...policy(), retainOnFailure: true },
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeSessionId: "session-abc",
      completedAttempts: 3,
    },
  });

  const outcome = await runLoop({
    task: "resume retained",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  const claudeCalls = retained.executeCalls.filter((call) =>
    call.command.includes("/usr/local/bin/claude") &&
    "HARNESS_PROMPT" in call.env
  );
  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0]?.command, buildClaudeCommand("resume"));
  assert.equal(claudeCalls[0]?.env.HARNESS_CLAUDE_SESSION_ID, "session-abc");
  assert.match(claudeCalls[0]?.env.HARNESS_PROMPT ?? "", /门禁反馈/);
});
```

Update the `ScriptedProvider` interface and fake provider implementation in the same test file to include:

```ts
  attachHandle?: RecordingHandle;
  attachedIds: string[];
```

and implement:

```ts
    async attach(id: string) {
      attachedIds.push(id);
      if (!attachHandle) throw new Error(`missing retained sandbox ${id}`);
      return attachHandle;
    },
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js --test-name-pattern "retained Daytona resume"
```

Expected: build fails because `createDaytonaRunEnvironment()` does not accept `resume`.

- [ ] **Step 3: Add resume options**

In `src/harness/sandbox/environment.ts`, add:

```ts
export interface DaytonaRunResumeOptions {
  agentSandboxId: string;
  claudeSessionId?: string;
  completedAttempts: number;
}
```

Then add to `DaytonaRunEnvironmentOptions`:

```ts
  resume?: DaytonaRunResumeOptions;
```

- [ ] **Step 4: Seed retained state**

Replace these local variables:

```ts
  let agentAttempt = 0;
  let claudeSessionId: string | undefined;
```

with:

```ts
  let agentAttempt = options.resume?.completedAttempts ?? 0;
  let claudeSessionId: string | undefined = options.resume?.claudeSessionId;
```

Add validation after `const observability = ...`:

```ts
  if (options.resume) {
    if (!Number.isSafeInteger(options.resume.completedAttempts) || options.resume.completedAttempts < 1) {
      throw new Error("resume completedAttempts must be a positive safe integer");
    }
    if (options.agent.kind === "claude" && options.resume.claudeSessionId !== undefined) {
      buildClaudeCommand("resume");
    }
  }
```

- [ ] **Step 5: Attach instead of creating when resume is configured**

At the top of `ensureAgent()`, after the `if (agentHandle) return agentHandle;` check, add:

```ts
    if (options.resume) {
      if (!options.provider.attach) {
        throw new Error("Sandbox provider does not support retained sandbox attach");
      }
      observe("agent.attach.start", { id: options.resume.agentSandboxId });
      const attachStartedAt = Date.now();
      const handle = await options.provider.attach(options.resume.agentSandboxId);
      observe("agent.attach.end", {
        id: handle.id,
        role: "agent",
        durationMs: durationSince(attachStartedAt),
      });
      if (options.agent.kind === "claude") {
        observe("agent.preflight.start", { id: handle.id });
        const preflightStartedAt = Date.now();
        const preflight = await handle.execute(
          CLAUDE_TOOLCHAIN_PREFLIGHT,
          REMOTE_ROOT,
          {},
          30_000,
        );
        assertClaudeToolchain(preflight);
        observe("agent.preflight.end", {
          id: handle.id,
          exitCode: preflight.exitCode,
          durationMs: durationSince(preflightStartedAt),
        });
      }
      agentHandle = handle;
      return handle;
    }
```

This intentionally skips `agent.upload` and `agent.setup` for resumed sandboxes. The retained workspace is the candidate being recovered.

- [ ] **Step 6: Keep failure retention conservative**

In `close()`, keep the existing condition:

```ts
        (!options.policy.retainOnFailure || published)
```

The CLI resume path will pass a policy object with `retainOnFailure: true`, so failed resumes keep the retained sandbox. Passing resumes still delete after publish because `published` is true.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js --test-name-pattern "retained Daytona resume"
```

Expected: retained attach tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/harness/sandbox/environment.ts test/daytona-environment.test.ts
git commit -m "feat: resume retained Daytona agent environments"
```

---

### Task 4: Validate Resume Requests from RunStore

**Files:**
- Create: `src/harness/resume.ts`
- Test: `test/resume.test.ts`

- [ ] **Step 1: Write validation tests**

Create `test/resume.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRetainedRunResumeRequest,
  type CurrentRepoState,
} from "../src/harness/resume.js";
import type { RunRecordV3 } from "../src/harness/record.js";

const repo: CurrentRepoState = {
  head: "abc123",
  dirty: false,
};

function record(overrides: Partial<RunRecordV3> = {}): RunRecordV3 {
  return {
    schemaVersion: 3,
    runId: "run-1",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:01:00.000Z",
    kind: "single",
    repo: {
      root: "/repo",
      gitRoot: "/repo",
      branch: "main",
      head: "abc123",
      dirty: false,
    },
    task: { description: "fix feature" },
    driver: "daytona(claude)",
    status: "completed",
    outcome: "escalated",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{
      attempt: 3,
      agentSandboxId: "sandbox-123",
      claudeSessionId: "session-abc",
      gateSandboxIds: ["gate-1"],
      gateOutcome: "fail",
    }],
    events: [],
    ...overrides,
  };
}

test("buildRetainedRunResumeRequest accepts retained escalated Claude runs", () => {
  assert.deepEqual(buildRetainedRunResumeRequest(record(), repo), {
    task: "fix feature",
    selectedContracts: ["gate-a"],
    agentSandboxId: "sandbox-123",
    claudeSessionId: "session-abc",
    completedAttempts: 3,
    sourceRunId: "run-1",
    sourceKind: "single",
  });
});

test("buildRetainedRunResumeRequest rejects deleted retained sandboxes", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(record({
      events: [{
        at: "2026-06-30T00:02:00.000Z",
        event: "agent.cleanup.end",
        data: { id: "sandbox-123", outcome: "deleted" },
      }],
    }), repo),
    /agent sandbox sandbox-123 was deleted/,
  );
});

test("buildRetainedRunResumeRequest rejects unsafe repo drift", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(record(), { head: "def456", dirty: false }),
    /current HEAD def456 does not match source run HEAD abc123/,
  );
  assert.throws(
    () => buildRetainedRunResumeRequest(record({ repo: { root: "/repo", dirty: true } }), repo),
    /source run started from a dirty worktree/,
  );
  assert.throws(
    () => buildRetainedRunResumeRequest(record(), { head: "abc123", dirty: true }),
    /current worktree has source changes/,
  );
});

test("buildRetainedRunResumeRequest rejects unsupported records", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(record({ driver: "daytona(command)" }), repo),
    /only daytona\(claude\) runs can be resumed/,
  );
  assert.throws(
    () => buildRetainedRunResumeRequest(record({ outcome: "ready_for_mr" }), repo),
    /only escalated runs can be resumed/,
  );
  assert.throws(
    () => buildRetainedRunResumeRequest(record({ selectedContracts: [] }), repo),
    /source run did not record selected contracts/,
  );
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npm run build
node --test dist/test/resume.test.js
```

Expected: build fails because `src/harness/resume.ts` does not exist.

- [ ] **Step 3: Implement resume validation**

Create `src/harness/resume.ts`:

```ts
import type { RunRecordKind, RunRecordV3 } from "./record.js";

export interface CurrentRepoState {
  head?: string;
  dirty?: boolean;
}

export interface RetainedRunResumeRequest {
  task: string;
  selectedContracts: string[];
  agentSandboxId: string;
  claudeSessionId?: string;
  completedAttempts: number;
  sourceRunId: string;
  sourceKind: RunRecordKind;
}

function eventObject(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
}

function latestAttempt(record: RunRecordV3) {
  return [...record.attempts]
    .sort((a, b) => b.attempt - a.attempt)
    .find((attempt) => typeof attempt.agentSandboxId === "string");
}

function sandboxWasDeleted(record: RunRecordV3, sandboxId: string): boolean {
  return record.events.some((event) => {
    if (event.event !== "agent.cleanup.end") return false;
    const data = eventObject(event.data);
    return data?.id === sandboxId && data.outcome === "deleted";
  });
}

export function buildRetainedRunResumeRequest(
  record: RunRecordV3,
  current: CurrentRepoState,
): RetainedRunResumeRequest {
  if (record.driver !== "daytona(claude)") {
    throw new Error("only daytona(claude) runs can be resumed");
  }
  if (record.outcome !== "escalated") {
    throw new Error("only escalated runs can be resumed");
  }
  if (record.repo.dirty === true) {
    throw new Error("source run started from a dirty worktree; retained resume cannot reconstruct its baseline safely");
  }
  if (record.repo.head && current.head && record.repo.head !== current.head) {
    throw new Error(`current HEAD ${current.head} does not match source run HEAD ${record.repo.head}`);
  }
  if (current.dirty === true) {
    throw new Error("current worktree has source changes; commit, stash, or revert them before retained resume");
  }
  if (record.selectedContracts.length === 0) {
    throw new Error("source run did not record selected contracts; retained resume cannot safely select Gate contracts");
  }

  const attempt = latestAttempt(record);
  if (!attempt?.agentSandboxId) {
    throw new Error("source run did not record an Agent sandbox id");
  }
  if (sandboxWasDeleted(record, attempt.agentSandboxId)) {
    throw new Error(`agent sandbox ${attempt.agentSandboxId} was deleted`);
  }
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
    throw new Error("source run attempt metadata is invalid");
  }

  return {
    task: record.task.description,
    selectedContracts: [...record.selectedContracts],
    agentSandboxId: attempt.agentSandboxId,
    ...(attempt.claudeSessionId ? { claudeSessionId: attempt.claudeSessionId } : {}),
    completedAttempts: attempt.attempt,
    sourceRunId: record.runId,
    sourceKind: record.kind,
  };
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run build
node --test dist/test/resume.test.js
```

Expected: all resume validation tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/harness/resume.ts test/resume.test.ts
git commit -m "feat: validate retained run resume requests"
```

---

### Task 5: Update Series Ledger after Successful Series-Task Resume

**Files:**
- Modify: `src/harness/series.ts`
- Test: `test/harness-series.test.ts`

- [ ] **Step 1: Write failing series ledger helper test**

Append this test near the series ledger tests in `test/harness-series.test.ts`:

```ts
test("markSeriesTaskReadyToCommit records resumed publication for escalated task", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-series-retained-resume-"));
  const config = loadTaskSeriesConfig({
    series: { id: "order-refactor" },
    autoCommit: { enabled: false, messageTemplate: "harness: {id}" },
    tasks: [
      { id: "one", task: "Recover retained candidate." },
    ],
  })!;
  const now = "2026-06-30T00:00:00.000Z";
  writeSeriesLedger(cwd, {
    schemaVersion: 1,
    seriesId: config.seriesId,
    status: "error",
    configHash: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    tasks: [{
      id: "one",
      taskHash: taskHash(config.tasks[0]!, config.autoCommit, config.taskDefaults),
      status: "escalated",
      startedAt: now,
      runRecord: ".harness/runs/source.json",
      errorReason: "达到硬上限 3 轮",
    }],
  });

  markSeriesTaskReadyToCommit({
    cwd,
    config,
    taskId: "one",
    runRecordPath: ".harness/runs/resume.json",
    changedFiles: ["src/a.ts"],
  });

  const ledger = readSeriesLedger(cwd, config.seriesId)!;
  assert.equal(ledger.status, "running");
  assert.deepEqual(ledger.tasks[0], {
    id: "one",
    taskHash: taskHash(config.tasks[0]!, config.autoCommit, config.taskDefaults),
    status: "ready_to_commit",
    startedAt: now,
    changedFiles: ["src/a.ts"],
    runRecord: ".harness/runs/resume.json",
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "markSeriesTaskReadyToCommit"
```

Expected: build fails because `markSeriesTaskReadyToCommit` does not exist.

- [ ] **Step 3: Implement the helper**

In `src/harness/series.ts`, add this exported interface near the other series input interfaces:

```ts
export interface MarkSeriesTaskReadyToCommitInput {
  cwd: string;
  config: TaskSeriesConfig;
  taskId: string;
  runRecordPath: string;
  changedFiles: string[];
}
```

Add this exported function after `writeSeriesLedger()`:

```ts
export function markSeriesTaskReadyToCommit(
  input: MarkSeriesTaskReadyToCommitInput,
): void {
  const ledger = readSeriesLedger(input.cwd, input.config.seriesId);
  if (!ledger) {
    throw new Error(`series ledger not found: ${input.config.seriesId}`);
  }
  const task = input.config.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error(`unknown series task: ${input.taskId}`);
  const existing = ledger.tasks.find((item) => item.id === input.taskId);
  if (!existing) throw new Error(`series ledger task not found: ${input.taskId}`);
  const currentTaskHash = taskHash(
    task,
    input.config.autoCommit,
    input.config.taskDefaults,
  );
  if (existing.taskHash !== currentTaskHash) {
    throw new Error(`task ${input.taskId} configuration changed since the retained run`);
  }
  updateLedgerTask(ledger, {
    id: input.taskId,
    taskHash: currentTaskHash,
    status: "ready_to_commit",
    startedAt: existing.startedAt,
    changedFiles: [...input.changedFiles],
    runRecord: input.runRecordPath,
  });
  ledger.status = "running";
  writeUpdatedLedger(input.cwd, ledger);
}
```

- [ ] **Step 4: Run focused test**

Run:

```bash
npm run build
node --test dist/test/harness-series.test.js --test-name-pattern "markSeriesTaskReadyToCommit"
```

Expected: the new series ledger helper test passes.

- [ ] **Step 5: Commit**

```bash
git add src/harness/series.ts test/harness-series.test.ts
git commit -m "feat: mark resumed series tasks ready to commit"
```

---

### Task 6: Add `harness runs resume <runId>`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write CLI validation tests**

Add this test to `test/cli.test.ts`:

```ts
test("CLI runs resume rejects missing run records", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-"));
  const result = spawnSync(
    process.execPath,
    [cliPath, "runs", "resume", "missing-run"],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /未找到 run 记录: missing-run/);
});

test("CLI help documents runs resume", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /harness runs resume <runId>/);
});
```

Add a CLI test that writes a completed non-Claude RunStore record and verifies validation fails before Daytona credentials are required:

```ts
test("CLI runs resume validates source run before Daytona attach", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-"));
  mkdirSync(join(cwd, ".harness", "runs"), { recursive: true });
  writeFileSync(join(cwd, ".harness", "runs", "bad-run.json"), JSON.stringify({
    schemaVersion: 3,
    runId: "bad-run",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    kind: "single",
    repo: { root: cwd, dirty: false },
    task: { description: "bad" },
    driver: "daytona(command)",
    status: "completed",
    outcome: "escalated",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{
      attempt: 1,
      agentSandboxId: "sandbox-123",
      gateSandboxIds: [],
    }],
    events: [],
  }, null, 2));

  const result = spawnSync(
    process.execPath,
    [cliPath, "runs", "resume", "bad-run"],
    { cwd, encoding: "utf8", env: { ...process.env, DAYTONA_API_KEY: "" } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /only daytona\(claude\) runs can be resumed/);
  assert.doesNotMatch(result.stderr + result.stdout, /DAYTONA_API_KEY/);
});
```

- [ ] **Step 2: Run the CLI tests and verify they fail**

Run:

```bash
npm run build
node --test dist/test/cli.test.js --test-name-pattern "runs resume"
```

Expected: tests fail because `runs resume` is not implemented or help text is missing.

- [ ] **Step 3: Add current repo helper in `src/cli.ts`**

Import these items:

```ts
import { spawnSync } from "node:child_process";
import {
  buildRetainedRunResumeRequest,
  type CurrentRepoState,
} from "./harness/resume.js";
import {
  markSeriesTaskReadyToCommit,
} from "./harness/series.js";
```

If `spawnSync` is already imported in `src/cli.ts`, reuse that import instead of adding a duplicate.

Add:

```ts
function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function currentRepoState(cwd: string): CurrentRepoState {
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    ...(gitOutput(cwd, ["rev-parse", "HEAD"]) ? { head: gitOutput(cwd, ["rev-parse", "HEAD"]) } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  };
}
```

- [ ] **Step 4: Implement `cmdRunsResume()`**

Add this function before `cmdRuns()`:

```ts
async function cmdRunsResume(args: string[]): Promise<void> {
  const { values, positionals } = parse(args);
  const runId = positionals[1];
  if (!runId) fail("用法: harness runs resume <runId> [--dir d] [--config f] [--max-attempts n] [--max-ms ms] [--verbose]");

  const cwd = process.cwd();
  const store = new RunStore(cwd);
  const source = store.readRun(runId);
  if (!source) fail(`未找到 run 记录: ${runId}`);

  const resume = buildRetainedRunResumeRequest(source, currentRepoState(cwd));
  const config = loadHarnessConfig(cwd, values.config as string | undefined);
  const policy = { ...loadSandboxPolicy(config), retainOnFailure: true };
  const contracts = loadRunnableContracts(resolve(cwd, values.dir as string));
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const selected = resume.selectedContracts.map((id) => {
    const contract = byId.get(id);
    if (!contract) throw new Error(`source run selected missing contract: ${id}`);
    return contract;
  });
  const gate = await buildGate(values.properties as string | undefined);
  const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
  if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl =
    values["base-url"] as string;

  const result = await runSingleTask(args, resume.task, undefined, {
    kind: source.kind === "series-task" ? "series-task" : "single",
    ...(source.parentRunId ? { parentRunId: source.parentRunId } : {}),
    ...(source.task.taskId ? { taskId: source.task.taskId } : {}),
    ...(source.task.seriesId ? { seriesId: source.task.seriesId } : {}),
    ...(source.task.index ? { taskIndex: source.task.index } : {}),
    ...(source.task.total ? { taskTotal: source.task.total } : {}),
    selectedContracts: selected,
    retainedResume: {
      sourceRunId: resume.sourceRunId,
      agentSandboxId: resume.agentSandboxId,
      claudeSessionId: resume.claudeSessionId,
      completedAttempts: resume.completedAttempts,
      policy,
      gate,
      ctx,
    },
  });

  if (
    result.outcome.outcome === "ready_for_mr" &&
    source.kind === "series-task" &&
    source.task.seriesId &&
    source.task.taskId
  ) {
    const seriesConfig = loadTaskSeriesConfig(config);
    if (!seriesConfig || seriesConfig.seriesId !== source.task.seriesId) {
      throw new Error(`current config does not contain source series ${source.task.seriesId}`);
    }
    markSeriesTaskReadyToCommit({
      cwd,
      config: seriesConfig,
      taskId: source.task.taskId,
      runRecordPath: result.runRecordPath,
      changedFiles: result.outcome.publication?.changedFiles ?? [],
    });
  }

  process.exitCode = result.outcome.outcome === "ready_for_mr"
    ? 0
    : result.outcome.outcome === "blocked"
      ? 2
      : 1;
}
```

The `retainedResume` override does not exist yet. Add it in the next step.

- [ ] **Step 5: Extend `SingleTaskRunOverrides` and `runSingleTask()`**

Find `SingleTaskRunOverrides` in `src/cli.ts` and add:

```ts
  retainedResume?: {
    sourceRunId: string;
    agentSandboxId: string;
    claudeSessionId?: string;
    completedAttempts: number;
    policy: SandboxPolicy;
    gate: GateCore;
    ctx: RunContext;
  };
```

In `runSingleTask()`, after creating the recorder and before selecting the agent, record the source event when present:

```ts
    if (overrides?.retainedResume) {
      recorder.recordEvent("run.resume.source", {
        runId: overrides.retainedResume.sourceRunId,
        agentSandboxId: overrides.retainedResume.agentSandboxId,
        completedAttempts: overrides.retainedResume.completedAttempts,
      });
    }
```

In `runSingleTask()`, use retained Gate pieces when present:

```ts
    const selected = overrides?.selectedContracts ?? (values.stage
```

already exists. Keep it.

Replace:

```ts
    const gate = await buildGate(values.properties as string | undefined);
```

with:

```ts
    const gate = overrides?.retainedResume?.gate ??
      await buildGate(values.properties as string | undefined);
```

Replace:

```ts
    const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
```

with:

```ts
    const ctx: RunContext = overrides?.retainedResume?.ctx ??
      { cwd, verdicts: loadVerdicts(cwd) };
```

Replace:

```ts
    const policy = loadSandboxPolicy(config);
```

with:

```ts
    const policy = overrides?.retainedResume?.policy ?? loadSandboxPolicy(config);
```

When creating the Daytona environment, add:

```ts
        ...(overrides?.retainedResume
          ? {
            resume: {
              agentSandboxId: overrides.retainedResume.agentSandboxId,
              ...(overrides.retainedResume.claudeSessionId
                ? { claudeSessionId: overrides.retainedResume.claudeSessionId }
                : {}),
              completedAttempts: overrides.retainedResume.completedAttempts,
            },
          }
          : {}),
```

When calling `runLoop()`, add:

```ts
      ...(overrides?.retainedResume ? { startWithGate: true } : {}),
```

- [ ] **Step 6: Route `runs resume`**

In `cmdRuns()`, add before `if (sub === "show")`:

```ts
  if (sub === "resume") {
    await cmdRunsResume(args);
    return;
  }
```

Change `cmdRuns()` to `async function cmdRuns(args: string[]): Promise<void>` and update the main switch:

```ts
    case "runs": await cmdRuns(rest); break;
```

Update the usage failure line:

```ts
  fail("用法: harness runs [list|show <runId>|resume <runId>] [--json] [--task-id id] [--series-id id]");
```

Update help text to include:

```ts
  harness runs resume <runId> [--max-attempts n] [--max-ms ms] [--verbose]
```

- [ ] **Step 7: Run focused CLI tests**

Run:

```bash
npm run build
node --test dist/test/cli.test.js --test-name-pattern "runs resume"
```

Expected: the new CLI validation tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: add retained run resume command"
```

---

### Task 7: Document Retained Resume Operations

**Files:**
- Modify: `docs/usage.md`
- Modify: `docs/daytona-local-claude-code-runbook.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`

- [ ] **Step 1: Update usage docs**

In `docs/usage.md`, add this section near the `retainOnFailure` explanation:

```md
### Retained sandbox resume

`sandbox.retainOnFailure: true` keeps an unpublished Daytona Agent sandbox after an escalated Claude run. It does not make ordinary `harness run` implicitly reuse old state. To explicitly recover that retained candidate, run:

```bash
harness runs resume <runId> --driver claude --max-attempts 2
```

Resume is intentionally conservative:

- only `daytona(claude)` escalated runs are supported;
- the original run must have recorded `agentSandboxId` and selected contracts;
- the original Agent sandbox must not have been deleted;
- the current Git `HEAD` must match the source run and the current worktree must be clean;
- Harness validates the retained candidate with Gate before starting another Claude command;
- if Gate passes, Harness publishes the candidate and deletes the retained sandbox;
- if Gate still fails, Harness resumes Claude with the recorded session id and keeps the sandbox on failure.
```

- [ ] **Step 2: Update runbook**

In `docs/daytona-local-claude-code-runbook.md`, add this operational flow near the strong resume section:

```md
## Recovering a retained failed run

When a run escalates because Gate was wrong or unavailable, first inspect the run:

```bash
harness runs show <runId> --json
```

If the run used `sandbox.retainOnFailure: true`, has an `attempts[].agentSandboxId`, and does not contain an `agent.cleanup.end` event with `outcome=deleted`, fix the Gate issue on the host and resume explicitly:

```bash
harness runs resume <runId> --driver claude --max-attempts 2
```

The resume command attaches to the retained Agent sandbox, collects the existing candidate, runs Gate first, and publishes without another Claude turn if the fixed Gate passes. If Gate still fails, it feeds the new diagnostics into `claude --resume <sessionId>` inside the same retained Agent sandbox.
```

- [ ] **Step 3: Update architecture docs**

In `docs/architecture/daytona-sandbox-gate.md`, add this paragraph after the existing strong resume rules:

```md
Cross-run retained resume is explicit. A retained Agent sandbox can be reused only through `harness runs resume <runId>`, which validates RunStore metadata, attaches by `agentSandboxId`, skips Agent upload/setup, runs Gate against the retained candidate first, and only then resumes Claude if new diagnostics are needed. Ordinary `harness run` never silently attaches to an old sandbox.
```

- [ ] **Step 4: Run doc-adjacent tests**

Run:

```bash
npm run build
node --test dist/test/daytona-gate-snapshot.test.js dist/test/daytona-examples.test.js
```

Expected: documentation tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/usage.md docs/daytona-local-claude-code-runbook.md docs/architecture/daytona-sandbox-gate.md
git commit -m "docs: describe retained sandbox resume"
```

---

### Task 8: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript build exits 0.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: 602 or more tests pass, 0 fail. If running inside a sandbox that blocks `127.0.0.1` listeners, rerun with permission that allows local loopback and record that reason in the final verification note.

- [ ] **Step 3: Inspect public CLI help**

Run:

```bash
node dist/src/cli.js help
```

Expected: help includes `harness runs resume <runId>`.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat HEAD~7..HEAD
git diff HEAD~7..HEAD -- src/harness/sandbox/types.ts src/harness/sandbox/daytona.ts src/harness/sandbox/environment.ts src/harness/run.ts src/harness/resume.ts src/harness/series.ts src/cli.ts
```

Expected: changes are limited to retained resume plumbing, tests, and docs.

- [ ] **Step 5: Final commit if any verification-only doc note was added**

If verification adds a note file, commit it:

```bash
git add docs/archive
git commit -m "docs: record retained resume verification"
```

If no verification note is added, do not create an empty commit.

---

## Risks And Decisions

- **Baseline reconstruction:** The resume command refuses dirty source runs and current HEAD drift because RunStore does not contain the original full baseline snapshot.
- **Gate-first behavior:** This is deliberate. The most common retained-sandbox recovery case is a broken Gate, so the preserved candidate should get a chance to pass before Claude edits again.
- **Series continuation:** A successful series-task resume marks the task `ready_to_commit`; the existing series resume path remains responsible for committing and continuing later tasks.
- **Command driver:** Not supported in this pass. It lacks a durable session id and a defined prompt feedback contract after process exit.
- **Cleanup:** Successful publish deletes the retained sandbox. Failed resume keeps it by forcing `retainOnFailure: true` for the resumed environment.

## Self-Review

- Spec coverage: covers attach, Gate-first resume, Claude session continuation, RunStore validation, series ledger recovery, docs, and verification.
- Placeholder scan: no task relies on an unspecified future API; every new public function has a concrete signature and test.
- Type consistency: `RetainedRunResumeRequest`, `DaytonaRunResumeOptions`, `SandboxProvider.attach`, and `markSeriesTaskReadyToCommit` names are used consistently across tasks.

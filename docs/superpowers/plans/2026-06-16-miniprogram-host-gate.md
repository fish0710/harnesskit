# Mini-Program Host Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `miniprogram` contract that validates WeChat mini-program behavior on the host while Daytona agents remain sandboxed.

**Architecture:** The `miniprogram` plugin classifies host-owned command evidence from a project runner. Local `harness check/gate` runs the plugin in the current working tree; Daytona `harness run` splits remote contracts from host-local mini-program contracts, materializes the candidate snapshot into a temporary host workspace, runs host-local checks there, aggregates all results, and publishes only after the combined gate passes.

**Tech Stack:** TypeScript, Node.js `node:test`, existing `GateCore` plugin API, existing `ExecutionTarget` evidence protocol, Daytona sandbox candidate snapshots.

---

## File Structure

- Create `src/plugins/miniprogram.ts`
  - Owns `type: "miniprogram"` contract parsing, DevTools startup, runner execution, and host-side evidence classification.
- Create `src/harness/host-gate.ts`
  - Owns host-local candidate materialization and execution of host-only contracts against a temporary workspace.
- Modify `src/contracts.ts`
  - Adds `miniprogram` required fields.
- Modify `src/cli.ts`
  - Registers `miniprogramPlugin` in `buildGate()`.
- Modify `src/index.ts`
  - Exports `miniprogramPlugin` and host-gate helpers that are useful for tests or downstream embedding.
- Modify `src/harness/sandbox/environment.ts`
  - Splits remote contracts and host-local contracts in Daytona run mode, runs both domains, aggregates results, and blocks publication on cleanup/materialization errors.
- Create `test/miniprogram-plugin.test.ts`
  - Plugin field validation, DevTools startup, runner execution, evidence validation, and diagnostics.
- Create `test/host-gate.test.ts`
  - Host temporary workspace materialization and cleanup behavior.
- Modify `test/loader-selector.test.ts`
  - Contract schema coverage for `miniprogram`.
- Modify `test/daytona-environment.test.ts`
  - Mixed remote/host gate execution, failure feedback to agent, repeated failure escalation, and cleanup failure preventing publication.
- Modify `test/remote-gate.test.ts`
  - Evidence-domain tests for the new plugin using injected execution target.
- Modify `docs/architecture/gate-plugin-guide.md`
  - Documents the new contract type and host-local execution domain.
- Modify `docs/architecture/daytona-sandbox-gate.md`
  - Documents mixed gate execution.

---

### Task 1: Contract Schema And Registration

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `src/plugins/miniprogram.ts`
- Modify: `test/loader-selector.test.ts`
- Create: `test/miniprogram-plugin.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add this test to `test/loader-selector.test.ts` after the existing known-type required-field test:

```ts
test("loader: miniprogram 缺 projectPath 或 runner → issue", () => {
  const missingProject = validateContract({
    id: "mp.missing-project",
    type: "miniprogram",
    runner: "test/gates/miniprogram-runner.js",
  });
  assert.ok(
    missingProject.some((issue) =>
      /type="miniprogram" 缺少必填字段 "projectPath"/.test(issue.message)
    ),
  );

  const missingRunner = validateContract({
    id: "mp.missing-runner",
    type: "miniprogram",
    projectPath: "dist/dev/mp-weixin",
  });
  assert.ok(
    missingRunner.some((issue) =>
      /type="miniprogram" 缺少必填字段 "runner"/.test(issue.message)
    ),
  );

  assert.deepEqual(
    validateContract({
      id: "mp.ok",
      type: "miniprogram",
      projectPath: "dist/dev/mp-weixin",
      runner: "test/gates/miniprogram-runner.js",
    }),
    [],
  );
});
```

- [ ] **Step 2: Write failing plugin registration test**

Create `test/miniprogram-plugin.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { GateCore } from "../src/gate.js";
import { miniprogramPlugin } from "../src/plugins/miniprogram.js";

test("miniprogram plugin registers under a stable type", () => {
  const gate = new GateCore().use(miniprogramPlugin);
  assert.deepEqual(gate.plugins(), ["miniprogram"]);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm run build
node --test dist/test/loader-selector.test.js dist/test/miniprogram-plugin.test.js
```

Expected:

- `npm run build` fails because `../src/plugins/miniprogram.js` does not exist, or
- the schema assertion fails because `REQUIRED_BY_TYPE` does not include `miniprogram`.

- [ ] **Step 4: Add minimal plugin stub and schema registration**

Create `src/plugins/miniprogram.ts`:

```ts
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

export const miniprogramPlugin: Plugin = {
  type: "miniprogram",

  async run(contract: Contract, _ctx: RunContext): Promise<CheckResult> {
    return {
      id: contract.id,
      type: this.type,
      status: "error",
      durationMs: 0,
      violations: [],
      errorReason: "miniprogram 插件尚未实现执行逻辑",
    };
  },
};
```

Modify `src/contracts.ts`:

```ts
const REQUIRED_BY_TYPE: Record<string, string[]> = {
  command: ["cmd"],
  boot: ["cmd"],
  http: ["trigger"],
  structure: ["tool"],
  invariant: ["property"],
  miniprogram: ["projectPath", "runner"],
  review: [],
};
```

Modify `src/cli.ts` imports and `buildGate()`:

```ts
import { miniprogramPlugin } from "./plugins/miniprogram.js";
```

```ts
const gate = new GateCore()
  .use(commandPlugin)
  .use(bootPlugin)
  .use(reviewPlugin)
  .use(httpPlugin)
  .use(structurePlugin)
  .use(miniprogramPlugin);
```

Modify `src/index.ts` next to other plugin exports:

```ts
export { miniprogramPlugin } from "./plugins/miniprogram.js";
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm run build
node --test dist/test/loader-selector.test.js dist/test/miniprogram-plugin.test.js
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/contracts.ts src/cli.ts src/index.ts src/plugins/miniprogram.ts \
  test/loader-selector.test.ts test/miniprogram-plugin.test.ts
git commit -m "feat: register miniprogram contracts"
```

---

### Task 2: Plugin Validation And Runner Evidence

**Files:**
- Modify: `src/plugins/miniprogram.ts`
- Modify: `test/miniprogram-plugin.test.ts`
- Modify: `test/remote-gate.test.ts`

- [ ] **Step 1: Write failing plugin validation tests**

Append to `test/miniprogram-plugin.test.ts`:

```ts
import type {
  CommandExecutionRequest,
  ExecutionTarget,
  HttpExecutionRequest,
} from "../src/harness/execution.js";

function unusedRequest(_request: HttpExecutionRequest): Promise<never> {
  return Promise.reject(new Error("HTTP execution was not expected"));
}

function fakeExecution(
  response: (request: CommandExecutionRequest) => {
    executionId?: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    error?: string;
  },
): { execution: ExecutionTarget; calls: CommandExecutionRequest[] } {
  const calls: CommandExecutionRequest[] = [];
  return {
    calls,
    execution: {
      async execute(request) {
        calls.push(request);
        const result = response(request);
        return {
          executionId: result.executionId ?? request.executionId,
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          durationMs: result.durationMs ?? 5,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      },
      request: unusedRequest,
    },
  };
}

test("miniprogram plugin errors on invalid project or runner paths", async () => {
  const result = await miniprogramPlugin.run(
    {
      id: "mp.invalid",
      type: "miniprogram",
      projectPath: "../dist",
      runner: "/tmp/runner.js",
    },
    { cwd: process.cwd() },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /路径|path|越界|absolute|绝对/);
});

test("miniprogram plugin classifies runner exit 0 as pass", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.pass",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args.slice(-1), ["test/fixtures/miniprogram-runner.js"]);
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, "test/fixtures/mp-project");
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:9420");
});

test("miniprogram plugin classifies runner non-zero as fail", async () => {
  const { execution } = fakeExecution(() => ({
    exitCode: 7,
    stdout: "home title mismatch\nline 2\nline 3\nline 4\nline 5",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.fail",
      type: "miniprogram",
      scenario: "首页契约必须通过",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.what ?? "", /退出码 7/);
  assert.match(result.violations[0]?.why ?? "", /首页契约/);
  assert.match(result.violations[0]?.how ?? "", /home title mismatch/);
  assert.doesNotMatch(result.violations[0]?.how ?? "", /line 5/);
});

test("miniprogram plugin rejects mismatched or incomplete evidence as error", async () => {
  const { execution } = fakeExecution(() => ({
    executionId: "forged",
    exitCode: 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.evidence",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /ID|不匹配|不可信/);
});
```

- [ ] **Step 2: Add fixture files used by tests**

Create fixture files:

```bash
mkdir -p test/fixtures/mp-project test/fixtures
printf '{"miniprogramRoot":"miniprogram/"}\n' > test/fixtures/mp-project/project.config.json
printf 'process.exit(0)\n' > test/fixtures/miniprogram-runner.js
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

Expected: tests fail because the plugin still returns the stub `error`.

- [ ] **Step 4: Implement field parsing and connect-mode runner execution**

Replace `src/plugins/miniprogram.ts` with:

```ts
import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import {
  commandEvidenceError,
  executionId,
  localExecutionTarget,
} from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

interface DevtoolsConfig {
  mode?: "managed" | "connect";
  cliPath?: string;
  autoPort?: number;
  trustProject?: boolean;
  wsEndpoint?: string;
}

interface MiniProgramContract extends Contract {
  projectPath?: unknown;
  runner?: unknown;
  devtools?: unknown;
  expectExit?: unknown;
  timeoutMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (isAbsolute(value)) return undefined;
  const normalized = normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function boundedCommandOutput(stderr: string, stdout: string): string | undefined {
  const sections: string[] = [];
  const add = (label: string, value: string) => {
    const text = value.trim();
    if (!text) return;
    const bounded = text.split("\n").slice(0, 4).join("\n").slice(0, 1000);
    sections.push(`${label}:\n${bounded}`);
  };
  add("stderr", stderr);
  add("stdout", stdout);
  return sections.length ? sections.join("\n") : undefined;
}

function parseDevtools(value: unknown): DevtoolsConfig {
  if (!isRecord(value)) return { mode: "managed" };
  const mode = value.mode === "connect" ? "connect" : "managed";
  return {
    mode,
    ...(typeof value.cliPath === "string" ? { cliPath: value.cliPath } : {}),
    ...(typeof value.autoPort === "number" ? { autoPort: value.autoPort } : {}),
    ...(typeof value.trustProject === "boolean" ? { trustProject: value.trustProject } : {}),
    ...(typeof value.wsEndpoint === "string" ? { wsEndpoint: value.wsEndpoint } : {}),
  };
}

export const miniprogramPlugin: Plugin = {
  type: "miniprogram",

  async run(contract: MiniProgramContract, ctx: RunContext): Promise<CheckResult> {
    const projectPath = safeRelativePath(contract.projectPath);
    const runner = safeRelativePath(contract.runner);
    if (!projectPath || !runner) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "miniprogram 契约的 projectPath 和 runner 必须是工作区内相对路径",
      };
    }

    const projectAbs = resolve(ctx.cwd, projectPath);
    const runnerAbs = resolve(ctx.cwd, runner);
    if (!existsSync(projectAbs)) {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: `小程序项目目录不存在: ${projectPath}` };
    }
    if (!existsSync(resolve(projectAbs, "project.config.json"))) {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: `小程序项目缺少 project.config.json: ${projectPath}` };
    }
    if (!existsSync(runnerAbs)) {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: `小程序 runner 不存在: ${runner}` };
    }

    const devtools = parseDevtools(contract.devtools);
    if (devtools.mode === "managed") {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "managed DevTools mode will be implemented in the next task" };
    }
    if (!devtools.wsEndpoint) {
      return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "connect mode requires devtools.wsEndpoint" };
    }

    const expectedExit = typeof contract.expectExit === "number" ? contract.expectExit : 0;
    const timeoutMs = typeof contract.timeoutMs === "number" ? contract.timeoutMs : undefined;
    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: process.execPath,
      args: [runner],
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      env: {
        ...process.env,
        HARNESS_MINIPROGRAM_PROJECT: projectPath,
        HARNESS_MINIPROGRAM_PROJECT_ABS: projectAbs,
        HARNESS_MINIPROGRAM_WS_ENDPOINT: devtools.wsEndpoint,
      },
    });
    const durationMs = evidence.durationMs;
    const evidenceError = commandEvidenceError(id, evidence);
    if (evidenceError) {
      return { id: contract.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: `小程序 runner 无法启动或执行证据不可信: ${evidenceError}` };
    }
    if (evidence.exitCode === expectedExit) {
      return { id: contract.id, type: this.type, status: "pass", durationMs, violations: [] };
    }
    return {
      id: contract.id,
      type: this.type,
      status: "fail",
      durationMs,
      violations: [{
        what: `小程序 runner 退出码 ${evidence.exitCode}，期望 ${expectedExit}`,
        why: contract.scenario ? String(contract.scenario) : "小程序行为未达契约",
        how: boundedCommandOutput(evidence.stderr, evidence.stdout) ?? "检查小程序自动化 runner 输出",
        ref: typeof contract.ref === "string" ? contract.ref : undefined,
      }],
    };
  },
};
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

Expected: plugin tests pass.

- [ ] **Step 6: Add remote evidence regression tests**

Append to `test/remote-gate.test.ts`:

```ts
import { miniprogramPlugin } from "../src/plugins/miniprogram.js";

test("miniprogram plugin sends trusted runner execution request", async () => {
  let call: CommandExecutionRequest | undefined;
  const execution: ExecutionTarget = {
    async execute(request) {
      call = request;
      return {
        executionId: request.executionId,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 8,
      };
    },
    request: unusedRequest,
  };

  const result = await miniprogramPlugin.run(
    {
      id: "mp.remote",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      timeoutMs: 1234,
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.ok(call?.executionId);
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ["test/fixtures/miniprogram-runner.js"]);
  assert.equal(call.timeoutMs, 1234);
});
```

- [ ] **Step 7: Run remote evidence tests**

Run:

```bash
npm run build
node --test dist/test/remote-gate.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/plugins/miniprogram.ts test/miniprogram-plugin.test.ts \
  test/remote-gate.test.ts test/fixtures/mp-project/project.config.json \
  test/fixtures/miniprogram-runner.js
git commit -m "feat: run miniprogram contract runners"
```

---

### Task 3: Managed WeChat DevTools Startup

**Files:**
- Modify: `src/plugins/miniprogram.ts`
- Modify: `test/miniprogram-plugin.test.ts`

- [ ] **Step 1: Write failing managed-mode tests**

Append to `test/miniprogram-plugin.test.ts`:

```ts
test("miniprogram plugin starts managed DevTools before runner", async () => {
  const { execution, calls } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 0 : 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.managed",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
        trustProject: true,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.command, "/Applications/WeChatDevTools/cli");
  assert.deepEqual(calls[0]!.args, [
    "auto",
    "--project",
    `${process.cwd()}/test/fixtures/mp-project`,
    "--auto-port",
    "19420",
    "--trust-project",
  ]);
  assert.equal(calls[1]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:19420");
  assert.equal(calls[1]!.env?.HARNESS_MINIPROGRAM_DEVTOOLS_PORT, "19420");
});

test("miniprogram plugin reports managed DevTools startup failure as error", async () => {
  const { execution } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 2 : 0,
    stderr: request.command === "/Applications/WeChatDevTools/cli" ? "trust failed" : "",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.devtools-error",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /DevTools|trust failed|退出码 2/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

Expected: managed tests fail because managed mode still returns an unimplemented error.

- [ ] **Step 3: Implement managed startup**

Modify `src/plugins/miniprogram.ts`:

```ts
const DEFAULT_DEVTOOLS_CLI =
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const DEFAULT_AUTO_PORT = 9420;
```

Add helper:

```ts
async function startManagedDevtools(
  contract: Contract,
  ctx: RunContext,
  cliPath: string,
  projectAbs: string,
  port: number,
  trustProject: boolean,
  timeoutMs: number | undefined,
): Promise<CheckResult | undefined> {
  const args = [
    "auto",
    "--project",
    projectAbs,
    "--auto-port",
    String(port),
    ...(trustProject ? ["--trust-project"] : []),
  ];
  const id = executionId();
  const evidence = await (ctx.execution ?? localExecutionTarget).execute({
    executionId: id,
    command: cliPath,
    args,
    cwd: ctx.cwd,
    timeoutMs,
    signal: ctx.signal,
    env: { ...process.env },
  });
  const evidenceError = commandEvidenceError(id, evidence);
  if (evidenceError) {
    return { id: contract.id, type: "miniprogram", status: "error", durationMs: evidence.durationMs, violations: [],
      errorReason: `微信开发者工具启动失败或证据不可信: ${evidenceError}` };
  }
  if (evidence.exitCode !== 0) {
    return { id: contract.id, type: "miniprogram", status: "error", durationMs: evidence.durationMs, violations: [],
      errorReason: `微信开发者工具启动退出码 ${evidence.exitCode}: ${
        boundedCommandOutput(evidence.stderr, evidence.stdout) ?? "(无输出)"
      }` };
  }
  return undefined;
}
```

Replace the managed-mode branch in `run()` with:

```ts
let wsEndpoint = devtools.wsEndpoint;
let devtoolsPort: number | undefined;
if (devtools.mode === "managed") {
  const cliPath = devtools.cliPath ?? DEFAULT_DEVTOOLS_CLI;
  if (!existsSync(cliPath) && !ctx.execution) {
    return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
      errorReason: `微信开发者工具 CLI 不存在: ${cliPath}` };
  }
  devtoolsPort = devtools.autoPort ?? DEFAULT_AUTO_PORT;
  const startupError = await startManagedDevtools(
    contract,
    ctx,
    cliPath,
    projectAbs,
    devtoolsPort,
    devtools.trustProject !== false,
    timeoutMs,
  );
  if (startupError) return startupError;
  wsEndpoint = `ws://127.0.0.1:${devtoolsPort}`;
}
if (!wsEndpoint) {
  return { id: contract.id, type: this.type, status: "error", durationMs: 0, violations: [],
    errorReason: "miniprogram devtools requires a WebSocket endpoint" };
}
```

Set runner env:

```ts
HARNESS_MINIPROGRAM_WS_ENDPOINT: wsEndpoint,
...(devtoolsPort !== undefined
  ? { HARNESS_MINIPROGRAM_DEVTOOLS_PORT: String(devtoolsPort) }
  : {}),
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

Expected: all plugin tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/miniprogram.ts test/miniprogram-plugin.test.ts
git commit -m "feat: start managed WeChat DevTools gates"
```

---

### Task 4: Host Candidate Materialization

**Files:**
- Create: `src/harness/host-gate.ts`
- Create: `test/host-gate.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing materialization tests**

Create `test/host-gate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  materializeCandidateWorkspace,
  runHostLocalGate,
} from "../src/harness/host-gate.js";
import { GateCore } from "../src/gate.js";
import type { Plugin } from "../src/types.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import { workspaceFile } from "../src/harness/sandbox/workspace.js";
import type {
  CandidateSnapshot,
  WorkspaceSnapshot,
} from "../src/harness/sandbox/types.js";

function snapshot(root: string, files: Record<string, string>): WorkspaceSnapshot {
  return {
    root,
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        workspaceFile(path, Buffer.from(content), false),
      ]),
    ),
  };
}

function candidate(files: Record<string, string>): CandidateSnapshot {
  return {
    operations: [],
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        workspaceFile(path, Buffer.from(content), false),
      ]),
    ),
  };
}

test("materializeCandidateWorkspace writes candidate bytes and restores protected files", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(root, {
    "src/a.ts": "before\n",
    "src/deleted.ts": "delete me\n",
    "contracts/mp.yaml": "trusted contract\n",
  });
  const next = candidate({ "src/a.ts": "after\n" });

  materializeCandidateWorkspace(root, baseline, next, policy);

  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "after\n");
  assert.equal(existsSync(join(root, "src/deleted.ts")), false);
  assert.equal(readFileSync(join(root, "contracts/mp.yaml"), "utf8"), "trusted contract\n");
});

test("runHostLocalGate executes contracts in a temporary candidate workspace", async () => {
  const realRoot = mkdtempSync(join(tmpdir(), "harness-real-root-"));
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
  const baseline = snapshot(realRoot, {
    "src/a.ts": "before\n",
    "contracts/mp.yaml": "trusted\n",
  });
  const next = candidate({ "src/a.ts": "after\n" });
  let observedCwd = "";
  const plugin: Plugin = {
    type: "miniprogram",
    async run(contract, ctx) {
      observedCwd = ctx.cwd;
      return {
        id: contract.id,
        type: this.type,
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "after\n" ? "pass" : "fail",
        durationMs: 1,
        violations: [],
      };
    },
  };

  const report = await runHostLocalGate({
    contracts: [{ id: "mp.host", type: "miniprogram", projectPath: "src", runner: "contracts/mp.yaml" }],
    gate: new GateCore().use(plugin),
    ctx: { cwd: realRoot },
    baseline,
    candidate: next,
    policy,
  });

  assert.equal(report.outcome, "pass");
  assert.notEqual(observedCwd, realRoot);
  assert.equal(existsSync(observedCwd), false);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm run build
node --test dist/test/host-gate.test.js
```

Expected: build fails because `src/harness/host-gate.ts` does not exist.

- [ ] **Step 3: Implement host materialization helper**

Create `src/harness/host-gate.ts`:

```ts
import {
  chmodSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import type { GateCore } from "../gate.js";
import type { Contract, GateReport, RunContext } from "../types.js";
import type {
  CandidateSnapshot,
  SandboxPolicy,
  WorkspaceFile,
  WorkspaceSnapshot,
} from "./sandbox/types.js";
import { agentVisibleFiles } from "./sandbox/workspace.js";

export interface HostLocalGateOptions {
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  baseline: WorkspaceSnapshot;
  candidate: CandidateSnapshot;
  policy: SandboxPolicy;
}

function writeWorkspaceFile(root: string, file: WorkspaceFile): void {
  const destination = join(root, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content);
  chmodSync(destination, file.executable ? 0o755 : 0o644);
}

function removeIfPresent(root: string, path: string): void {
  try {
    unlinkSync(join(root, path));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export function materializeCandidateWorkspace(
  root: string,
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): void {
  for (const file of baseline.files.values()) {
    writeWorkspaceFile(root, file);
  }
  for (const file of agentVisibleFiles(baseline, policy)) {
    removeIfPresent(root, file.path);
  }
  for (const file of candidate.files.values()) {
    writeWorkspaceFile(root, file);
  }
  for (const file of baseline.files.values()) {
    if (!agentVisibleFiles(baseline, policy).some((mutable) => mutable.path === file.path)) {
      writeWorkspaceFile(root, file);
    }
  }
}

export async function runHostLocalGate(
  options: HostLocalGateOptions,
): Promise<GateReport> {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  try {
    materializeCandidateWorkspace(
      root,
      options.baseline,
      options.candidate,
      options.policy,
    );
    return await options.gate.run(options.contracts, {
      ...options.ctx,
      cwd: root,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function isHostLocalContract(contract: Contract): boolean {
  return contract.type === "miniprogram";
}
```

Modify `src/index.ts`:

```ts
export {
  isHostLocalContract,
  materializeCandidateWorkspace,
  runHostLocalGate,
} from "./harness/host-gate.js";
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm run build
node --test dist/test/host-gate.test.js
```

Expected: host-gate tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/harness/host-gate.ts src/index.ts test/host-gate.test.ts
git commit -m "feat: materialize host gate candidates"
```

---

### Task 5: Mixed Daytona Gate Execution

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing mixed-gate test**

Append to `test/daytona-environment.test.ts`:

```ts
test("Daytona gate runs miniprogram contracts on host materialized candidate", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const hostPlugin = {
    type: "miniprogram",
    async run(contract: { id: string; type: string }, ctx: { cwd: string }) {
      return {
        id: contract.id,
        type: "miniprogram",
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "fixed\n"
          ? "pass"
          : "fail",
        durationMs: 1,
        violations: [],
      } as const;
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [
      { id: "remote.command", type: "command", cmd: "true" },
      { id: "mp.host", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(commandPlugin).use(hostPlugin),
    ctx: { cwd: root },
  });

  assert.equal(report.outcome, "pass");
  assert.equal(report.summary.total, 2);
  const gate = provider.handles.find((handle) => handle.role === "gate")!;
  assert.ok(gate.commands.some((command) => command.includes("'true'")));
});
```

- [ ] **Step 2: Write failing host-only gate test**

Append:

```ts
test("Daytona run skips remote gate sandbox when only host-local contracts are selected", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [],
  });
  const hostPlugin = {
    type: "miniprogram",
    async run(contract: { id: string; type: string }, ctx: { cwd: string }) {
      return {
        id: contract.id,
        type: "miniprogram",
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "fixed\n"
          ? "pass"
          : "fail",
        durationMs: 1,
        violations: [],
      } as const;
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [
      { id: "mp.only", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
  });

  assert.equal(report.outcome, "pass");
  assert.equal(provider.requests.filter((request) => request.role === "gate").length, 0);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
```

Expected: at least one test fails because every contract currently runs in the remote gate sandbox.

- [ ] **Step 4: Implement mixed gate split and aggregation**

Modify `src/harness/sandbox/environment.ts` imports:

```ts
import { aggregate } from "../../aggregate.js";
import {
  isHostLocalContract,
  runHostLocalGate,
} from "../host-gate.js";
```

Inside `runGate()`, after `pendingCandidate` is collected, split contracts:

```ts
const hostContracts = contracts.filter(isHostLocalContract);
const remoteContracts = contracts.filter((contract) => !isHostLocalContract(contract));
const combinedResults: CheckResult[] = [];
```

Wrap the existing gate sandbox creation block so it only runs when
`remoteContracts.length > 0`, and pass `remoteContracts` to `gate.run()` and
`shouldBlockGateNetwork(remoteContracts)`.

After the remote gate block and before cleanup-result checks return, run host
contracts:

```ts
if (hostContracts.length > 0 && pendingCandidate) {
  observe("host-gate.run.start", { contracts: hostContracts.length });
  const hostStartedAt = Date.now();
  try {
    const hostReport = await runHostLocalGate({
      contracts: hostContracts,
      gate,
      ctx,
      baseline,
      candidate: pendingCandidate,
      policy: options.policy,
    });
    combinedResults.push(...hostReport.results);
    observe("host-gate.run.end", {
      outcome: hostReport.outcome,
      results: hostReport.results.length,
      durationMs: durationSince(hostStartedAt),
    });
  } catch (error) {
    return integrityReport(
      `Host-local gate failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
```

Whenever a remote report is produced, push its results:

```ts
combinedResults.push(...report.results);
```

Replace the final report selection with:

```ts
if (!report && remoteContracts.length > 0) {
  return integrityReport("Gate did not produce a report");
}
if (cleanupError) {
  return integrityReport(`Gate sandbox cleanup failed: ${
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
  }`);
}
const finalReport = aggregate(combinedResults);
if (finalReport.outcome === "pass") approvedCandidate = pendingCandidate;
return finalReport;
```

For `remoteContracts.length === 0`, do not create a `gateHandle` and rely on
the host-local report.

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
```

Expected: environment tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/sandbox/environment.ts test/daytona-environment.test.ts
git commit -m "feat: run host-local miniprogram gates"
```

---

### Task 6: Feedback Loop And Escalation Coverage

**Files:**
- Modify: `test/daytona-environment.test.ts`

- [ ] **Step 1: Write failing feedback-loop test**

Append to `test/daytona-environment.test.ts`:

```ts
test("miniprogram gate failure feeds diagnostics back to the Daytona agent", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [],
  });
  const hostPlugin = {
    type: "miniprogram",
    async run(contract: { id: string; type: string }, ctx: { cwd: string }) {
      const content = readFileSync(join(ctx.cwd, "src/a.ts"), "utf8");
      return content === "fixed\n"
        ? { id: contract.id, type: "miniprogram", status: "pass", durationMs: 1, violations: [] } as const
        : {
          id: contract.id,
          type: "miniprogram",
          status: "fail",
          durationMs: 1,
          violations: [{
            what: "mini-program home page did not render",
            why: "小程序首页必须可见",
            how: "fix src/a.ts",
          }],
        } as const;
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix mp",
    contracts: [
      { id: "mp.loop", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.match(provider.agentPrompts[1] ?? "", /mp.loop|mini-program home page|fix src\/a.ts/);
});
```

- [ ] **Step 2: Write failing repeated-failure escalation test**

Append:

```ts
test("repeated miniprogram gate failure escalates to human_review_contract", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "broken\n", "broken\n"],
    gateExitCodes: [],
  });
  const hostPlugin = {
    type: "miniprogram",
    async run(contract: { id: string; type: string }) {
      return {
        id: contract.id,
        type: "miniprogram",
        status: "fail",
        durationMs: 1,
        violations: [{
          what: "mini-program contract remains red",
          why: "同一小程序契约重复失败",
          how: "review contract or fix implementation",
        }],
      } as const;
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix mp",
    contracts: [
      { id: "mp.repeat", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
    environment,
    budget: { ...budget, repeatWallThreshold: 2, maxAttempts: 5 },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.action?.kind, "human_review_contract");
});
```

- [ ] **Step 3: Run tests to verify RED or current failure mode**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
```

Expected before Task 5 is complete: tests fail because mixed host-local gates do not run. Expected after Task 5 is complete: tests pass without further production changes because `runLoop()` already handles fail streaks and feedback.

- [ ] **Step 4: If needed, keep production code unchanged and verify GREEN**

If Task 5 was implemented correctly, no production code change is needed. Run:

```bash
node --test dist/test/daytona-environment.test.js
```

Expected: all environment tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/daytona-environment.test.ts
git commit -m "test: cover miniprogram gate feedback"
```

---

### Task 7: Local CLI Coverage

**Files:**
- Modify: `test/frozen-contract-callers.test.ts` or create `test/miniprogram-cli.test.ts`

- [ ] **Step 1: Write failing CLI integration test**

Create `test/miniprogram-cli.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("CLI check registers miniprogram plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-miniprogram-cli-"));
  write(join(root, "contracts/mp.yaml"), [
    "id: mp.cli",
    "type: miniprogram",
    "projectPath: dist/dev/mp-weixin",
    "runner: test/gates/miniprogram-runner.js",
    "devtools:",
    "  mode: connect",
    "  wsEndpoint: ws://127.0.0.1:9420",
    "",
  ].join("\n"));
  write(join(root, "dist/dev/mp-weixin/project.config.json"), "{}\n");
  write(join(root, "test/gates/miniprogram-runner.js"), "process.exit(0)\n");

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist/src/cli.js"), "check", "--dir", "contracts", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"id": "mp.cli"/);
  assert.match(result.stdout, /"status": "pass"/);
});
```

- [ ] **Step 2: Run tests to verify RED or existing GREEN**

Run:

```bash
npm run build
node --test dist/test/miniprogram-cli.test.js
```

Expected before Task 1 is complete: CLI check fails because the plugin is not registered. Expected after Tasks 1-3: test passes.

- [ ] **Step 3: Commit**

```bash
git add test/miniprogram-cli.test.ts
git commit -m "test: cover miniprogram CLI checks"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/architecture/gate-plugin-guide.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`

- [ ] **Step 1: Update gate plugin guide**

Add a `miniprogram` section after `http`:

~~~markdown
### miniprogram

用途：在宿主机本地连接微信开发者工具，执行小程序自动化契约。该插件用于
macOS 本地 DevTools 场景，不在 Daytona gate sandbox 内运行。

```yaml
id: mp.home.smoke
type: miniprogram
scenario: 小程序首页和关键交互必须通过
projectPath: dist/dev/mp-weixin
runner: test/gates/miniprogram-runner.js
devtools:
  mode: managed
  cliPath: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
  autoPort: 9420
  trustProject: true
timeoutMs: 120000
```

`projectPath` 指当前验证工作区内的小程序项目目录，例如编译后的
`dist/dev/mp-weixin`。`runner` 是受保护的 Node.js 自动化脚本，可以使用
`miniprogram-automator` 连接 `HARNESS_MINIPROGRAM_WS_ENDPOINT`。

Daytona `harness run` 模式下，agent 仍在 Daytona 沙箱中修改候选代码；
Harness 在宿主临时目录组装被收集的候选字节，再在宿主机执行
`miniprogram` 契约。通过后才发布候选字节到真实工作区。

runner 退出码等于 `expectExit` 时为 `pass`；runner 非零退出为 `fail`；
DevTools、runner 启动失败、超时或证据不可信为 `error`。
~~~

- [ ] **Step 2: Update Daytona architecture doc**

In `docs/architecture/daytona-sandbox-gate.md`, add a subsection after the gate sandbox flow:

~~~markdown
### Host-local mini-program gate

`miniprogram` 契约是特例：它依赖宿主机上的微信开发者工具，因此不放进
Daytona gate sandbox。`harness run` 会先收集 Daytona agent 产生的
`CandidateSnapshot`，再在宿主临时目录组装同一份候选字节，执行
`miniprogram` 契约，并把结果与远端 gate sandbox 的结果一起聚合。

这不会让 agent 在宿主机运行。agent 仍然只在 Daytona sandbox 中修改候选文件。
host-local gate 只读取被宿主收集和组装的候选字节；失败诊断仍回到同一个
agent sandbox 继续下一轮，重复失败和预算耗尽仍走统一升级策略。
~~~

- [ ] **Step 3: Run docs diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/gate-plugin-guide.md docs/architecture/daytona-sandbox-gate.md
git commit -m "docs: describe miniprogram host gates"
```

---

### Task 9: Full Verification

**Files:**
- No production changes.

- [ ] **Step 1: Run targeted compiled tests**

Run:

```bash
npm run build
node --test \
  dist/test/miniprogram-plugin.test.js \
  dist/test/host-gate.test.js \
  dist/test/miniprogram-cli.test.js \
  dist/test/daytona-environment.test.js \
  dist/test/remote-gate.test.js \
  dist/test/loader-selector.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full check**

Run:

```bash
npm run check
```

Expected in unrestricted shell: all tests pass. If this command is run inside a restricted command sandbox that cannot bind `127.0.0.1`, the two existing HTTP adapter tests can fail with `listen EPERM`; rerun in unrestricted shell and record that distinction.

- [ ] **Step 3: Run formatting whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Review final changed files**

Run:

```bash
git status --short
git log --oneline --max-count=8
```

Expected: only planned files are changed or all planned commits are present.

- [ ] **Step 5: Confirm no uncommitted implementation changes remain**

Run:

```bash
git status --short
```

Expected: no output after all task commits are complete.

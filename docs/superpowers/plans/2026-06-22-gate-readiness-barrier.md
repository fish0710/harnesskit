# Gate Readiness Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-run Gate readiness barrier that proves selected remote contracts can execute in the Daytona Gate sandbox before starting a mutating implementation agent.

**Architecture:** Add a focused `src/harness/preflight.ts` module for static runtime linting, runtime-failure classification, and Gate sandbox rehearsal. Wire it into `src/cli.ts` as `harness preflight gate`, then update scaffold and harness-prep documentation so Daytona runs require this barrier before `harness run`.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, existing Harness GateCore plugins, existing Daytona `SandboxProvider` abstraction, existing `harness.config.json` sandbox policy.

---

## File Structure

- Create `src/harness/preflight.ts`
  - Owns `GatePreflightReport`, `PreflightFinding`, `PreflightStep`.
  - Owns `lintGateReadiness()`, `classifyGateReportReadiness()`, `runGatePreflight()`, and pretty/JSON renderers.
  - Reuses `SandboxProvider`, `SandboxHandle`, `captureWorkspace()`, `createDaytonaExecutionTarget()`, and `GateCore`.

- Modify `src/index.ts`
  - Export preflight public types and helpers for tests and downstream callers.

- Modify `src/cli.ts`
  - Add `preflight gate` parsing and help text.
  - Reuse existing contract/config loading, plugin registration, selection, Daytona provider creation, and verdict loading.

- Modify `src/harness/scaffold.ts`
  - Update scaffolded `AGENTS.md` so implementation agents understand that local `harness check` is not equivalent to Gate sandbox readiness.

- Modify `plugins/harness-prep/skills/harness-prep/SKILL.md`
  - Add `harness preflight gate` to the required pre-run checklist.

- Modify harness-prep references:
  - `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`
  - `plugins/harness-prep/skills/harness-prep/references/reliability-checks.md`
  - `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`
  - `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
  - `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`

- Modify user docs:
  - `docs/usage.md`
  - `docs/architecture/daytona-sandbox-gate.md`

- Add tests:
  - `test/preflight-lint.test.ts`
  - `test/preflight-runtime.test.ts`
  - `test/cli-preflight.test.ts`
  - Extend `test/scaffold.test.ts`

---

### Task 1: Static Runtime Lint And Readiness Classification

**Files:**
- Create: `src/harness/preflight.ts`
- Create: `test/preflight-lint.test.ts`

- [ ] **Step 1: Write failing lint and classification tests**

Create `test/preflight-lint.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate } from "../src/aggregate.js";
import {
  classifyGateReportReadiness,
  lintGateReadiness,
} from "../src/harness/preflight.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import type { CheckResult, Contract } from "../src/types.js";

function policy(gateSetup: string[] = []) {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      gateSetup,
    },
  });
}

function ids(results: Array<{ id: string }>): string[] {
  return results.map((result) => result.id).sort();
}

test("preflight lint rejects bare nvm use in gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["nvm use 14.21.3 && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]?.message ?? "", /source .*nvm\.sh/i);
});

test("preflight lint accepts sourced nvm use in gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 14.21.3 && npm ci'",
    ]),
  });

  assert.deepEqual(findings.filter((finding) => finding.severity === "error"), []);
});

test("preflight lint rejects claude in gate setup and contracts", () => {
  const contracts: Contract[] = [
    { id: "agent.leak", type: "command", cmd: "claude", args: ["--version"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["claude --version"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.agent.leak.claude",
    "gateSetup.1.claude",
  ]);
  assert.ok(findings.every((finding) => finding.severity === "error"));
});

test("preflight lint reports default-missing package managers", () => {
  const contracts: Contract[] = [
    { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
    { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["bun install"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.lint.pnpm.tool",
    "contract.structure.yarn.tool",
    "gateSetup.1.tool",
  ]);
  assert.ok(findings.every((finding) => finding.severity === "error"));
});

test("preflight lint warns for loopback http without gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [
      {
        id: "api.health",
        type: "http",
        trigger: {
          method: "GET",
          baseUrl: "http://127.0.0.1:3000",
          path: "/health",
        },
        expect: { status: 200 },
      },
    ],
    policy: policy([]),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "contract.api.health.loopback");
  assert.equal(findings[0]?.severity, "warning");
  assert.match(findings[0]?.message ?? "", /gateSetup/i);
});

test("preflight readiness classification promotes command-not-found failures", () => {
  const result: CheckResult = {
    id: "test.unit",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 127，期望 0",
      why: "unit tests",
      how: "stderr:\npnpm: not found",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors.length, 1);
  assert.equal(classified.readinessErrors[0]?.contractId, "test.unit");
  assert.match(classified.readinessErrors[0]?.message ?? "", /pnpm: not found/);
});

test("preflight readiness classification keeps ordinary product failures separate", () => {
  const result: CheckResult = {
    id: "test.unit",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "unit tests",
      how: "stdout:\nexpected health endpoint to return ok",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures, ["test.unit"]);
});

test("preflight readiness classification treats gate errors as readiness errors", () => {
  const result: CheckResult = {
    id: "unknown.type",
    type: "unknown",
    status: "error",
    durationMs: 1,
    violations: [],
    errorReason: "没有注册处理 type",
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.equal(classified.readinessErrors.length, 1);
  assert.equal(classified.readinessErrors[0]?.contractId, "unknown.type");
  assert.match(classified.readinessErrors[0]?.message ?? "", /没有注册处理/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build
node --test dist/test/preflight-lint.test.js
```

Expected: build fails because `src/harness/preflight.ts` does not exist, or the test fails because the exported functions are missing.

- [ ] **Step 3: Implement linting and classification module**

Create `src/harness/preflight.ts` with these exported types and functions:

```ts
import { aggregate } from "../aggregate.js";
import type { GateCore } from "../gate.js";
import type { GateReport, Contract, RunContext } from "../types.js";
import { createDaytonaExecutionTarget } from "./sandbox/daytona.js";
import { getGateSnapshot } from "./sandbox/toolchain.js";
import type {
  SandboxCommandResult,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  WorkspaceFile,
} from "./sandbox/types.js";
import { captureWorkspace } from "./sandbox/workspace.js";
import { isHostLocalContract } from "./host-gate.js";

export type PreflightSeverity = "warning" | "error";

export interface PreflightFinding {
  id: string;
  severity: PreflightSeverity;
  message: string;
  source: "static" | "setup" | "contract" | "sandbox";
  contractId?: string;
}

export interface PreflightStep {
  label: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GatePreflightReport {
  outcome: "ready" | "not_ready" | "blocked";
  staticFindings: PreflightFinding[];
  setup: PreflightStep[];
  selectedContracts: string[];
  remoteContracts: string[];
  hostLocalContracts: string[];
  gateReport?: GateReport;
  readinessErrors: PreflightFinding[];
  productFailures: string[];
  sandbox?: { id: string; snapshot: string; retained: boolean };
}

export interface GateReadinessLintInput {
  contracts: Contract[];
  policy: SandboxPolicy;
}

export interface GateReadinessClassification {
  readinessErrors: PreflightFinding[];
  productFailures: string[];
}

const REMOTE_ROOT = "/workspace/candidate";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MISSING_DEFAULT_TOOLS = new Set(["git", "pnpm", "yarn", "bun"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shellWordPattern(word: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_./-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_/-]|$)`);
}

function includesShellWord(command: string, word: string): boolean {
  return shellWordPattern(word).test(command);
}

function hasBareNvmUse(command: string): boolean {
  return includesShellWord(command, "nvm") &&
    /\bnvm\s+use\b/.test(command) &&
    !command.includes("/usr/local/nvm/nvm.sh");
}

function usesNvmInstall(command: string): boolean {
  return includesShellWord(command, "nvm") && /\bnvm\s+install\b/.test(command);
}

function commandMentionsMissingTool(command: string): string | undefined {
  for (const tool of MISSING_DEFAULT_TOOLS) {
    if (includesShellWord(command, tool)) return tool;
  }
  return undefined;
}

function bootstrapMentionsTool(command: string, tool: string): boolean {
  if (tool === "pnpm" || tool === "yarn") {
    return command.includes("corepack") ||
      command.includes(`npm install -g ${tool}`) ||
      command.includes(`npm i -g ${tool}`);
  }
  if (tool === "bun") {
    return command.includes("npm install -g bun") ||
      command.includes("npm i -g bun");
  }
  if (tool === "git") {
    return command.includes("apt-get install") && command.includes("git");
  }
  return false;
}

function setupBootstrapsTool(policy: SandboxPolicy, tool: string): boolean {
  return policy.gateSetup.some((command) => bootstrapMentionsTool(command, tool));
}

function contractCommandText(contract: Contract): string | undefined {
  if (contract.type === "command" || contract.type === "boot") {
    const cmd = typeof contract.cmd === "string" ? contract.cmd : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return cmd ? `${cmd} ${args}`.trim() : undefined;
  }
  if (contract.type === "structure") {
    const tool = typeof contract.tool === "string" ? contract.tool : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return tool ? `${tool} ${args}`.trim() : undefined;
  }
  return undefined;
}

function httpContractUsesLoopback(contract: Contract): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) return false;
  const trigger = contract.trigger;
  const values = [trigger.url, trigger.baseUrl].filter(
    (value): value is string => typeof value === "string",
  );
  return values.some((value) => {
    try {
      const host = new URL(value).hostname;
      return host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost");
    } catch {
      return false;
    }
  });
}

function runtimeFailureText(value: string): boolean {
  const text = value.toLowerCase();
  return text.includes("command not found") ||
    text.includes(": not found") ||
    text.includes("nvm: not found") ||
    text.includes("nvm.sh") ||
    text.includes("cannot find module") ||
    text.includes("module not found") ||
    text.includes("missing script") ||
    text.includes("enoent") ||
    text.includes("network is unreachable") ||
    text.includes("could not resolve host");
}

function resultText(result: GateReport["results"][number]): string {
  return [
    result.errorReason ?? "",
    ...result.violations.flatMap((violation) => [
      violation.what,
      violation.why,
      violation.how,
      violation.file ?? "",
    ]),
  ].filter(Boolean).join("\n");
}

function finding(
  id: string,
  severity: PreflightSeverity,
  message: string,
  source: PreflightFinding["source"],
  contractId?: string,
): PreflightFinding {
  return {
    id,
    severity,
    message,
    source,
    ...(contractId ? { contractId } : {}),
  };
}

export function lintGateReadiness(input: GateReadinessLintInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  input.policy.gateSetup.forEach((command, index) => {
    const label = `gateSetup.${index + 1}`;
    if (hasBareNvmUse(command)) {
      findings.push(finding(
        `${label}.nvm`,
        "error",
        "Gate setup uses bare nvm. Use bash -lc 'source /usr/local/nvm/nvm.sh && nvm use <version> && ...'.",
        "static",
      ));
    }
    if (usesNvmInstall(command)) {
      findings.push(finding(
        `${label}.nvm-install`,
        "error",
        "Gate setup uses nvm install. Gate /usr/local/nvm is not writable; use a snapshot with the Node version preinstalled.",
        "static",
      ));
    }
    if (includesShellWord(command, "claude")) {
      findings.push(finding(
        `${label}.claude`,
        "error",
        "Gate setup must not run claude; Gate snapshots are intentionally agent-free.",
        "static",
      ));
    }
    const tool = commandMentionsMissingTool(command);
    if (tool && !bootstrapMentionsTool(command, tool)) {
      findings.push(finding(
        `${label}.tool`,
        "error",
        `Gate setup uses ${tool}, which is not in the default Gate snapshot. Install or enable it before invoking it.`,
        "static",
      ));
    }
  });

  for (const contract of input.contracts) {
    const command = contractCommandText(contract);
    if (command) {
      if (hasBareNvmUse(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm`,
          "error",
          "Contract command uses bare nvm. Source /usr/local/nvm/nvm.sh in gateSetup or in an explicit bash wrapper.",
          "static",
          contract.id,
        ));
      }
      if (usesNvmInstall(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm-install`,
          "error",
          "Contract command uses nvm install. Install Node versions in the Gate snapshot or gateSetup, not during contract execution.",
          "static",
          contract.id,
        ));
      }
      if (includesShellWord(command, "claude")) {
        findings.push(finding(
          `contract.${contract.id}.claude`,
          "error",
          "Gate contracts must not run claude; Gate snapshots do not include model tooling.",
          "static",
          contract.id,
        ));
      }
      const tool = commandMentionsMissingTool(command);
      if (tool && !setupBootstrapsTool(input.policy, tool)) {
        findings.push(finding(
          `contract.${contract.id}.tool`,
          "error",
          `Contract uses ${tool}, which is not in the default Gate snapshot and is not bootstrapped by gateSetup.`,
          "static",
          contract.id,
        ));
      }
      if (/\b(?:npm|pnpm|yarn|bun|pip3?)\s+(?:install|ci)\b/.test(command) || /\b(?:curl|wget)\b/.test(command)) {
        findings.push(finding(
          `contract.${contract.id}.network`,
          "warning",
          "Contract command appears to fetch dependencies or network resources. Move dependency installation to gateSetup before Gate network policy is applied.",
          "static",
          contract.id,
        ));
      }
    }
    if (httpContractUsesLoopback(contract) && input.policy.gateSetup.length === 0) {
      findings.push(finding(
        `contract.${contract.id}.loopback`,
        "warning",
        "Loopback HTTP contract targets the Gate sandbox. Add gateSetup that starts and waits for the service.",
        "static",
        contract.id,
      ));
    }
  }
  return findings;
}

export function classifyGateReportReadiness(
  report: GateReport,
): GateReadinessClassification {
  const readinessErrors: PreflightFinding[] = [];
  const productFailures: string[] = [];
  for (const result of report.results) {
    const text = resultText(result);
    if (result.status === "error") {
      readinessErrors.push(finding(
        `contract.${result.id}.error`,
        "error",
        text || "Gate contract returned error",
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail" && runtimeFailureText(text)) {
      readinessErrors.push(finding(
        `contract.${result.id}.runtime`,
        "error",
        text,
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail") productFailures.push(result.id);
  }
  return { readinessErrors, productFailures };
}
```

The file will be extended in Task 2 with `runGatePreflight()`.

- [ ] **Step 4: Run lint tests**

Run:

```bash
npm run build
node --test dist/test/preflight-lint.test.js
```

Expected: `preflight-lint.test.js` passes.

- [ ] **Step 5: Commit**

```bash
git add src/harness/preflight.ts test/preflight-lint.test.ts
git commit -m "feat: add gate preflight linting"
```

---

### Task 2: Runtime Gate Sandbox Rehearsal

**Files:**
- Modify: `src/harness/preflight.ts`
- Create: `test/preflight-runtime.test.ts`

- [ ] **Step 1: Write failing runtime preflight tests**

Create `test/preflight-runtime.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { GateCore } from "../src/gate.js";
import { runGatePreflight } from "../src/harness/preflight.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import type {
  SandboxCreateRequest,
  SandboxHandle,
  SandboxProvider,
  WorkspaceFile,
} from "../src/harness/sandbox/types.js";
import { workspaceFile } from "../src/harness/sandbox/workspace.js";
import { commandPlugin } from "../src/plugins/command.js";
import type { Contract } from "../src/types.js";

function createGitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-preflight-runtime-"));
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.invalid",
      "commit", "-m", "fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

function policy(gateSetup: string[] = []) {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src", "package.json"],
      protectedPaths: ["contracts"],
      gateSetup,
    },
  });
}

class RecordingGateHandle implements SandboxHandle {
  readonly files = new Map<string, WorkspaceFile>();
  readonly commands: string[] = [];
  readonly networkBlocks: boolean[] = [];
  deleted = 0;

  constructor(
    readonly id: string,
    private readonly exitCodes: Record<string, number>,
    private readonly outputs: Record<string, string> = {},
  ) {}

  async upload(files: WorkspaceFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(
        file.path,
        workspaceFile(file.path, file.content, file.executable),
      );
    }
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) this.files.delete(path);
  }

  async verify(): Promise<void> {}

  workspace() {
    return {
      list: async () =>
        [...this.files.values()].map((file) => ({
          path: file.path,
          kind: "file" as const,
          size: file.content.byteLength,
          executable: file.executable,
        })),
      read: async (path: string) => {
        const file = this.files.get(path);
        if (!file) throw new Error(`missing fake file: ${path}`);
        return Buffer.from(file.content);
      },
    };
  }

  async execute(command: string) {
    this.commands.push(command);
    const exitCode = this.exitCodes[command] ?? 0;
    const output = this.outputs[command] ?? (exitCode === 0 ? "ok" : `${command}: not found`);
    return {
      exitCode,
      stdout: exitCode === 0 ? output : "",
      stderr: exitCode === 0 ? "" : output,
    };
  }

  async runPty() {
    throw new Error("preflight must not use PTY");
  }

  async setNetworkBlocked(blocked: boolean): Promise<void> {
    this.networkBlocks.push(blocked);
  }

  async delete(): Promise<void> {
    this.deleted++;
  }
}

class RecordingProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  readonly handles: RecordingGateHandle[] = [];

  constructor(
    private readonly exitCodes: Record<string, number> = {},
    private readonly outputs: Record<string, string> = {},
  ) {}

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    this.requests.push(request);
    const handle = new RecordingGateHandle(
      `${request.role}-${this.handles.length + 1}`,
      this.exitCodes,
      this.outputs,
    );
    this.handles.push(handle);
    return handle;
  }
}

const trustedContract: Contract = {
  id: "test.unit",
  type: "command",
  cmd: "node",
  args: ["test.js"],
};

test("gate preflight creates a Gate sandbox, runs setup and contracts, then cleans up", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/test.yaml": "trusted\n",
  });
  const provider = new RecordingProvider();

  const report = await runGatePreflight({
    provider,
    root,
    policy: policy(["npm ci"]),
    contracts: [trustedContract],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment: { HARNESS_DAYTONA_GATE_SNAPSHOT: "gate-test-snapshot" },
  });

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.selectedContracts, ["test.unit"]);
  assert.deepEqual(report.remoteContracts, ["test.unit"]);
  assert.deepEqual(report.hostLocalContracts, []);
  assert.deepEqual(report.readinessErrors, []);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.role, "gate");
  assert.equal(provider.requests[0]?.snapshot, "gate-test-snapshot");
  assert.deepEqual(provider.requests[0]?.envVars, {});
  const gate = provider.handles[0]!;
  assert.ok(gate.files.has("src/a.ts"));
  assert.ok(gate.files.has("contracts/test.yaml"));
  assert.deepEqual(gate.commands, ["npm ci", "'/usr/bin/env' '--' 'node' 'test.js'"]);
  assert.deepEqual(gate.networkBlocks, [true]);
  assert.equal(gate.deleted, 1);
});

test("gate preflight blocks on setup failure before running contracts", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider({ "npm ci": 127 });

  const report = await runGatePreflight({
    provider,
    root,
    policy: policy(["npm ci"]),
    contracts: [trustedContract],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment: { HARNESS_DAYTONA_GATE_SNAPSHOT: "gate-test-snapshot" },
  });

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors.length, 1);
  assert.match(report.readinessErrors[0]?.message ?? "", /gate setup command 1 failed/i);
  const gate = provider.handles[0]!;
  assert.deepEqual(gate.commands, ["npm ci"]);
  assert.equal(gate.deleted, 1);
});

test("gate preflight keeps product failures separate from readiness errors", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider(
    { "'/usr/bin/env' '--' 'node' 'test.js'": 1 },
    { "'/usr/bin/env' '--' 'node' 'test.js'": "assertion failed" },
  );

  const report = await runGatePreflight({
    provider,
    root,
    policy: policy([]),
    contracts: [trustedContract],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment: { HARNESS_DAYTONA_GATE_SNAPSHOT: "gate-test-snapshot" },
  });

  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.readinessErrors, []);
  assert.deepEqual(report.productFailures, ["test.unit"]);
});

test("gate preflight reports host-local contracts as outside Gate coverage", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const miniprogram: Contract = {
    id: "mp.smoke",
    type: "miniprogram",
    projectPath: "dist/dev/mp-weixin",
    runner: "test/gates/runner.js",
  };

  const report = await runGatePreflight({
    provider,
    root,
    policy: policy([]),
    contracts: [miniprogram],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment: { HARNESS_DAYTONA_GATE_SNAPSHOT: "gate-test-snapshot" },
  });

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.remoteContracts, []);
  assert.deepEqual(report.hostLocalContracts, ["mp.smoke"]);
  assert.deepEqual(provider.requests, []);
});
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run:

```bash
npm run build
node --test dist/test/preflight-runtime.test.js
```

Expected: fails because `runGatePreflight` is not implemented.

- [ ] **Step 3: Implement `runGatePreflight()`**

Append these helpers and the runner to `src/harness/preflight.ts`:

```ts
export interface GatePreflightOptions {
  provider: SandboxProvider;
  root: string;
  policy: SandboxPolicy;
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  environment?: Record<string, string | undefined>;
  retainOnFailure?: boolean;
}

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function commandOutput(result: SandboxCommandResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function setupFailure(
  index: number,
  command: string,
  result: SandboxCommandResult,
): PreflightFinding {
  return finding(
    `gateSetup.${index + 1}.failed`,
    "error",
    `gate setup command ${index + 1} failed with exit ${result.exitCode}: ${commandOutput(result) || "(no output)"}`,
    "setup",
  );
}

async function runPreflightSetup(
  handle: SandboxHandle,
  commands: string[],
): Promise<{ steps: PreflightStep[]; errors: PreflightFinding[] }> {
  const steps: PreflightStep[] = [];
  const errors: PreflightFinding[] = [];
  for (const [index, command] of commands.entries()) {
    const result = await handle.execute(
      command,
      REMOTE_ROOT,
      {},
      SETUP_TIMEOUT_MS,
    );
    steps.push({
      label: `gateSetup.${index + 1}`,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.exitCode !== 0) {
      errors.push(setupFailure(index, command, result));
      break;
    }
  }
  return { steps, errors };
}

function isLoopbackHost(value: string): boolean {
  return value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value.endsWith(".localhost");
}

function urlUsesLoopback(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function contractUsesLoopbackHttp(contract: Contract): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) return false;
  const { url, baseUrl } = contract.trigger;
  return (typeof url === "string" && urlUsesLoopback(url)) ||
    (typeof baseUrl === "string" && urlUsesLoopback(baseUrl));
}

function shouldBlockGateNetwork(contracts: Contract[]): boolean {
  return !contracts.some(contractUsesLoopbackHttp);
}

function finalOutcome(
  readinessErrors: PreflightFinding[],
  productFailures: string[],
  gateReport: GateReport | undefined,
): GatePreflightReport["outcome"] {
  if (gateReport?.outcome === "blocked") return "blocked";
  if (readinessErrors.length > 0 || productFailures.length > 0) {
    return "not_ready";
  }
  return "ready";
}

export async function runGatePreflight(
  options: GatePreflightOptions,
): Promise<GatePreflightReport> {
  const environment = options.environment ?? process.env;
  const staticFindings = lintGateReadiness({
    contracts: options.contracts,
    policy: options.policy,
  });
  const selectedContracts = options.contracts.map((contract) => contract.id);
  const remoteContracts = options.contracts.filter((contract) =>
    !isHostLocalContract(contract)
  );
  const hostLocalContracts = options.contracts.filter(isHostLocalContract);
  const hardStaticErrors = staticFindings.filter((finding) =>
    finding.severity === "error"
  );
  if (hardStaticErrors.length > 0) {
    return {
      outcome: "not_ready",
      staticFindings,
      setup: [],
      selectedContracts,
      remoteContracts: remoteContracts.map((contract) => contract.id),
      hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
      readinessErrors: hardStaticErrors,
      productFailures: [],
    };
  }

  if (remoteContracts.length === 0) {
    return {
      outcome: "ready",
      staticFindings,
      setup: [],
      selectedContracts,
      remoteContracts: [],
      hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
      readinessErrors: [],
      productFailures: [],
    };
  }

  const gateSnapshot = getGateSnapshot(environment);
  const baseline = captureWorkspace(options.root, options.policy);
  let handle: SandboxHandle | undefined;
  let retained = false;
  let setup: PreflightStep[] = [];
  let gateReport: GateReport | undefined;
  const readinessErrors: PreflightFinding[] = [];
  const productFailures: string[] = [];

  try {
    handle = await options.provider.create({
      role: "gate",
      snapshot: gateSnapshot,
      envVars: {},
      ephemeral: true,
    });
    await handle.upload([...baseline.files.values()], REMOTE_ROOT);
    const setupResult = await runPreflightSetup(handle, options.policy.gateSetup);
    setup = setupResult.steps;
    readinessErrors.push(...setupResult.errors);
    if (readinessErrors.length === 0) {
      if (shouldBlockGateNetwork(remoteContracts)) {
        await handle.setNetworkBlocked(true);
      }
      gateReport = await options.gate.run(remoteContracts, {
        ...options.ctx,
        cwd: REMOTE_ROOT,
        execution: createDaytonaExecutionTarget(handle, REMOTE_ROOT),
      });
      const classified = classifyGateReportReadiness(gateReport);
      readinessErrors.push(...classified.readinessErrors);
      productFailures.push(...classified.productFailures);
    }
  } catch (error) {
    readinessErrors.push(finding(
      "gate.sandbox.error",
      "error",
      error instanceof Error ? error.message : String(error),
      "sandbox",
    ));
  } finally {
    if (handle) {
      const shouldRetain = options.retainOnFailure &&
        (readinessErrors.length > 0 || productFailures.length > 0);
      if (shouldRetain) {
        retained = true;
      } else {
        try {
          await handle.delete();
        } catch (error) {
          readinessErrors.push(finding(
            "gate.cleanup.failed",
            "error",
            `Gate sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            "sandbox",
          ));
        }
      }
    }
  }

  const report: GatePreflightReport = {
    outcome: finalOutcome(readinessErrors, productFailures, gateReport),
    staticFindings,
    setup,
    selectedContracts,
    remoteContracts: remoteContracts.map((contract) => contract.id),
    hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
    ...(gateReport ? { gateReport } : {}),
    readinessErrors,
    productFailures,
    ...(handle ? { sandbox: { id: handle.id, snapshot: gateSnapshot, retained } } : {}),
  };
  return report;
}
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
npm run build
node --test dist/test/preflight-runtime.test.js
```

Expected: `preflight-runtime.test.js` passes.

- [ ] **Step 5: Run lint and runtime preflight tests together**

Run:

```bash
node --test dist/test/preflight-lint.test.js dist/test/preflight-runtime.test.js
```

Expected: both test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/preflight.ts test/preflight-runtime.test.ts
git commit -m "feat: rehearse gates in sandbox preflight"
```

---

### Task 3: CLI Command And Report Rendering

**Files:**
- Modify: `src/harness/preflight.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `test/cli-preflight.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `test/cli-preflight.test.ts`:

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-preflight-"));
  spawnSync("git", ["init"], { cwd, stdio: "ignore" });
  write(join(cwd, "src", "app.js"), "console.log('ok')\n");
  write(join(cwd, "contracts", "unit.json"), JSON.stringify({
    id: "test.unit",
    type: "command",
    cmd: "node",
    args: ["src/app.js"],
  }));
  write(join(cwd, "harness.config.json"), JSON.stringify({
    baseline: ["test.unit"],
    rules: [],
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      gateSetup: [],
    },
  }, null, 2));
  spawnSync("git", ["add", "."], { cwd, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.invalid",
      "commit", "-m", "fixture",
    ],
    { cwd, stdio: "ignore" },
  );
  return { cwd, contractsDir: join(cwd, "contracts") };
}

test("CLI help includes preflight gate", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /harness preflight gate/);
});

test("CLI preflight gate rejects static hard errors without Daytona credentials", () => {
  const { cwd, contractsDir } = fixture();
  write(join(cwd, "harness.config.json"), JSON.stringify({
    baseline: ["test.unit"],
    rules: [],
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      gateSetup: ["nvm use 14.21.3 && npm ci"],
    },
  }, null, 2));

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "preflight",
      "gate",
      "--dir",
      contractsDir,
      "--config",
      "harness.config.json",
      "--json",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as {
    outcome?: string;
    readinessErrors?: Array<{ id?: string; message?: string }>;
  };
  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors?.[0]?.id, "gateSetup.1.nvm");
  assert.match(report.readinessErrors?.[0]?.message ?? "", /nvm\.sh/);
  assert.equal(result.stderr, "");
});

test("CLI preflight gate validates contracts before Daytona creation", () => {
  const { cwd, contractsDir } = fixture();
  write(join(contractsDir, "bad.json"), JSON.stringify({
    id: "bad.command",
    type: "command",
  }));

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "preflight",
      "gate",
      "--dir",
      contractsDir,
      "--json",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /契约规格有问题/);
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
npm run build
node --test dist/test/cli-preflight.test.js
```

Expected: help test fails because the CLI does not know `preflight`.

- [ ] **Step 3: Add preflight renderers**

Append to `src/harness/preflight.ts`:

```ts
export function renderGatePreflightJson(report: GatePreflightReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderGatePreflightPretty(report: GatePreflightReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Harness Gate Preflight");
  lines.push(
    `selected ${report.selectedContracts.length} contracts; ` +
      `remote ${report.remoteContracts.length}; ` +
      `host-local ${report.hostLocalContracts.length}`,
  );
  lines.push(`outcome: ${report.outcome}`);
  if (report.sandbox) {
    lines.push(
      `sandbox: ${report.sandbox.id} ` +
        `snapshot=${report.sandbox.snapshot} ` +
        `retained=${report.sandbox.retained}`,
    );
  }
  for (const finding of report.staticFindings) {
    lines.push(`[${finding.severity}] ${finding.id}: ${finding.message}`);
  }
  for (const step of report.setup) {
    lines.push(
      `[setup] ${step.label} exit=${step.exitCode}: ${step.command}`,
    );
  }
  for (const finding of report.readinessErrors) {
    lines.push(`[readiness] ${finding.id}: ${finding.message}`);
  }
  for (const id of report.productFailures) {
    lines.push(`[product-red] ${id}`);
  }
  if (report.hostLocalContracts.length > 0) {
    lines.push(
      `[info] host-local contracts are not covered by Gate sandbox preflight: ` +
        report.hostLocalContracts.join(", "),
    );
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Wire `preflight gate` in CLI**

Modify `src/cli.ts` imports:

```ts
import {
  renderGatePreflightJson,
  renderGatePreflightPretty,
  runGatePreflight,
} from "./harness/preflight.js";
```

Add CLI options:

```ts
  "retain-on-failure": { type: "boolean" as const, default: false },
```

Add this helper near `cmdCheck` or after `cmdContract`:

```ts
function selectContractsForValues(
  contracts: Contract[],
  values: Record<string, unknown>,
): Contract[] {
  if (values.stage) {
    return selectByStage(contracts, values.stage as string);
  }
  if (values.changed) {
    const changedFiles = (values.changed as string)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    let config: SelectConfig = {
      baseline: contracts.map((contract) => contract.id),
      rules: [],
    };
    if (values.config) {
      config = JSON.parse(
        readFileSync(resolve(process.cwd(), values.config as string), "utf8"),
      ) as SelectConfig;
    }
    return selectByChange(contracts, config, changedFiles).selected;
  }
  return contracts;
}
```

Update `cmdCheck` to use this helper instead of duplicating selection. The selected result must remain identical to current behavior.

Add command handler:

```ts
async function cmdPreflight(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "gate") {
    fail("用法: harness preflight gate [--dir contracts] [--config harness.config.json] [--json]");
  }
  const { values } = parse(args.slice(1));
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);
  const contracts = loadRunnableContracts(dir);
  const selected = selectContractsForValues(
    contracts,
    values as Record<string, unknown>,
  );
  const gate = await buildGate(values.properties as string | undefined);
  const config = loadHarnessConfig(cwd, values.config as string | undefined);
  const policy = loadSandboxPolicy(config);
  const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
  if (values["base-url"]) {
    (ctx as { baseUrl?: string }).baseUrl = values["base-url"] as string;
  }
  const report = await runGatePreflight({
    provider: createDaytonaSdkProvider(process.env),
    root: cwd,
    policy,
    contracts: selected,
    gate,
    ctx,
    environment: process.env,
    retainOnFailure: Boolean(values["retain-on-failure"]),
  });
  console.log(
    values.json
      ? renderGatePreflightJson(report)
      : renderGatePreflightPretty(report),
  );
  process.exitCode = report.outcome === "ready"
    ? 0
    : report.outcome === "blocked"
      ? 2
      : 1;
}
```

Add to help text under validation commands:

```text
  harness preflight gate [--dir d] [--config f] [--stage s] [--changed a,b] [--json] # 在 Daytona Gate sandbox 中演练 setup/契约
```

Add to `main()` switch:

```ts
    case "preflight": await cmdPreflight(rest); break;
```

- [ ] **Step 5: Export public preflight API**

Add to `src/index.ts`:

```ts
export {
  classifyGateReportReadiness,
  lintGateReadiness,
  renderGatePreflightJson,
  renderGatePreflightPretty,
  runGatePreflight,
  type GatePreflightOptions,
  type GatePreflightReport,
  type GateReadinessClassification,
  type GateReadinessLintInput,
  type PreflightFinding,
  type PreflightSeverity,
  type PreflightStep,
} from "./harness/preflight.js";
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
npm run build
node --test dist/test/cli-preflight.test.js
```

Expected: `cli-preflight.test.js` passes.

- [ ] **Step 7: Run affected tests**

Run:

```bash
node --test dist/test/preflight-lint.test.js dist/test/preflight-runtime.test.js dist/test/cli-preflight.test.js dist/test/loader-selector.test.js
```

Expected: all listed tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/harness/preflight.ts src/cli.ts src/index.ts test/cli-preflight.test.ts
git commit -m "feat: add gate preflight cli"
```

---

### Task 4: Scaffold And Harness Prep Guidance

**Files:**
- Modify: `src/harness/scaffold.ts`
- Modify: `test/scaffold.test.ts`
- Modify: `plugins/harness-prep/skills/harness-prep/SKILL.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/reliability-checks.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`

- [ ] **Step 1: Write failing scaffold test**

Append to `test/scaffold.test.ts`:

```ts
test("create documents Gate sandbox preflight in AGENTS", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-agents-"));
  createProject(target);
  const agents = readFileSync(join(target, "AGENTS.md"), "utf8");

  assert.match(agents, /harness preflight gate/);
  assert.match(agents, /Gate sandbox/i);
  assert.match(agents, /harness check.*host/i);
});
```

- [ ] **Step 2: Run scaffold test to verify it fails**

Run:

```bash
npm run build
node --test dist/test/scaffold.test.js
```

Expected: the new scaffold test fails because `AGENTS.md` does not mention `harness preflight gate`.

- [ ] **Step 3: Update scaffolded `AGENTS.md`**

In `src/harness/scaffold.ts`, replace the workflow paragraph in the `AGENTS.md` template with:

```md
## 工作循环
读意图(docs/specs, docs/plans) → 改代码 → 跑 `harness check` 看宿主门禁反馈 → 跑 `harness preflight gate` 确认 Daytona Gate sandbox 能执行远端门禁 → 修到全绿 → 才算完成。
`harness check` 是宿主本地验证；`harness preflight gate` 才会创建 Gate sandbox 演练 gateSetup/远端契约。
你只能 push / 开 MR,不能合并;冻结契约(contracts/frozen/)不可改。
```

- [ ] **Step 4: Update harness-prep skill checklist**

In `plugins/harness-prep/skills/harness-prep/SKILL.md`, replace the pre-run checklist commands with:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness preflight gate --dir contracts --config harness.config.json --json
harness status --dir contracts
```

Also replace the source-checkout command block with:

```bash
npm run build
node dist/src/cli.js contract validate contracts
node dist/src/cli.js check --dir contracts --config harness.config.json --json
node dist/src/cli.js preflight gate --dir contracts --config harness.config.json --json
```

Add this sentence after the command block:

```md
`harness check` proves local contract behavior on the host. `harness preflight gate` proves selected remote contracts and `gateSetup` can execute in the Daytona Gate snapshot.
```

- [ ] **Step 5: Update run-supervision reference**

In `plugins/harness-prep/skills/harness-prep/references/run-supervision.md`, update the preflight validation block to:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness preflight gate --dir contracts --config harness.config.json --json
harness status --dir contracts
```

Add this outcome rule:

```md
If `harness preflight gate` reports readiness errors, fix config/setup/toolchain assumptions. Do not start Agent, and do not treat the error as an implementation task.
```

- [ ] **Step 6: Update reliability checklist**

In `plugins/harness-prep/skills/harness-prep/references/reliability-checks.md`, add this checklist item after local check:

```md
- [ ] `harness preflight gate --dir contracts --config harness.config.json --json` has no readiness errors for selected remote contracts.
```

Add this pressure-scenario expectation under "Sandbox environment ambiguity":

```md
- Expected: agent runs or requests `harness preflight gate` before starting Daytona agent execution; missing Gate tools are fixed in setup/config first.
```

- [ ] **Step 7: Update gate translation and contracts references**

In `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`, change the validation loop command block to:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness preflight gate --dir contracts --config harness.config.json --json
```

In `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`, change the validation block to include:

```bash
harness preflight gate --dir contracts --config harness.config.json
```

Add this rule near the setup rules:

```md
- Treat a Gate preflight readiness error as contract/config failure. Fix it before running an implementation agent.
```

- [ ] **Step 8: Update blocker-analysis reference**

In `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`, add `harness preflight gate --dir contracts --config harness.config.json --json` to the "Evidence Capture" command list after `harness status`.

Add this likely cause under "Contract/config error":

```md
- skipped or stale Gate preflight for a changed `gateSetup`, contract command, or Gate snapshot.
```

- [ ] **Step 9: Run scaffold and text checks**

Run:

```bash
npm run build
node --test dist/test/scaffold.test.js
rg -n "harness preflight gate" src/harness/scaffold.ts plugins/harness-prep/skills/harness-prep docs/usage.md docs/architecture/daytona-sandbox-gate.md
```

Expected: scaffold tests pass, and `rg` shows the new command in scaffold and harness-prep references. `docs/usage.md` and architecture docs are updated in Task 5, so they may not match yet in this task.

- [ ] **Step 10: Commit**

```bash
git add src/harness/scaffold.ts test/scaffold.test.ts plugins/harness-prep/skills/harness-prep
git commit -m "docs: require gate preflight in prep"
```

---

### Task 5: User Documentation And Architecture Notes

**Files:**
- Modify: `docs/usage.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`
- Modify: `README.md` if the command summary needs a short mention.

- [ ] **Step 1: Update usage manual validation flow**

In `docs/usage.md`, update the top-level flow from:

```text
-> check/gate 验证门禁可跑
```

to:

```text
-> check/gate 在宿主验证契约语义
-> preflight gate 在 Daytona Gate sandbox 演练 gateSetup 和远端契约
```

In section "4. 只跑验证，不启动 agent", add:

```md
在 Daytona agent 运行前，额外验证 Gate sandbox 运行时：

```bash
harness preflight gate --dir contracts --config harness.config.json --json
```

`harness check` 在宿主机本地执行。`harness preflight gate` 会创建短生命周期 Gate sandbox，上传当前工作区，执行 `gateSetup` 和选中的远端契约。它用于发现缺工具、裸 `nvm use`、Gate 里误用 `claude`、服务未在 Gate 内启动等 readiness 错误。
```

In "最短可复制流程", insert:

```bash
harness preflight gate --dir contracts --config harness.config.json
```

before `harness run`.

- [ ] **Step 2: Update troubleshooting**

In `docs/usage.md` section "常见卡点", add:

```md
`harness preflight gate` 报 readiness error：

```text
原因：Gate sandbox 中缺工具、gateSetup 失败、契约命令使用宿主才有的命令，或在 Gate 里误用 agent 工具。
处理：修 `harness.config.json` 的 `gateSetup` 或契约命令。不要启动 agent 重试业务代码，直到 preflight readiness error 清零。
```
```

- [ ] **Step 3: Update architecture doc**

In `docs/architecture/daytona-sandbox-gate.md`, add a subsection after the main execution flow:

```md
## Gate Readiness Preflight

`harness preflight gate` is the pre-run readiness barrier for Daytona-backed `run`.
It does not start an Agent sandbox and does not publish files. It creates a
fresh Gate sandbox from the configured Gate snapshot, uploads the current host
workspace, runs `gateSetup`, applies the same loopback-aware network policy as
`run`, and executes selected remote contracts through host-owned GateCore.

The command separates readiness errors from product-red gates. Readiness errors
include setup failure, missing commands, bad `nvm` usage, unknown contract
types, evidence errors, and Gate cleanup failure. These must be fixed in
contracts/config/setup before the implementation agent starts.
```

In the known-boundaries section, replace the local-check boundary with:

```md
- `harness check` 和 `harness gate` 仍保留本地执行语义；Daytona Gate 运行时由
  `harness preflight gate` 和 `harness run` 覆盖。
```

- [ ] **Step 4: Add README mention**

In `README.md`, after the local `npm run check` paragraph, add:

```md
Before starting a Daytona-backed implementation agent, verify Gate runtime
readiness:

```bash
node dist/src/cli.js preflight gate --dir contracts --config harness.config.json
```

This command creates a short-lived Gate sandbox and catches setup/toolchain
errors before they consume agent attempts.
```

- [ ] **Step 5: Run documentation grep and diff check**

Run:

```bash
rg -n "preflight gate|Gate readiness|readiness error" README.md docs/usage.md docs/architecture/daytona-sandbox-gate.md
git diff --check
```

Expected: command appears in all three docs, and `git diff --check` reports no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/usage.md docs/architecture/daytona-sandbox-gate.md
git commit -m "docs: document gate readiness preflight"
```

---

### Task 6: Full Verification And Optional Real Daytona Probe

**Files:**
- No planned source edits unless verification exposes a bug.

- [ ] **Step 1: Run full local check**

Run:

```bash
npm run check
```

Expected: TypeScript build passes and all unit tests pass.

- [ ] **Step 2: Verify CLI help and static preflight manually**

Run:

```bash
node dist/src/cli.js help | rg "preflight gate"
```

Expected: help text includes `harness preflight gate`.

Create a temporary fixture with a static failure:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
git init
mkdir -p src contracts
printf 'console.log("ok")\n' > src/app.js
printf '{"id":"test.unit","type":"command","cmd":"node","args":["src/app.js"]}\n' > contracts/unit.json
cat > harness.config.json <<'JSON'
{
  "baseline": ["test.unit"],
  "rules": [],
  "sandbox": {
    "candidateRoots": ["src"],
    "protectedPaths": ["contracts"],
    "gateSetup": ["nvm use 14.21.3 && npm ci"]
  }
}
JSON
git add .
git -c user.name=Harness -c user.email=harness@example.invalid commit -m fixture
node /Users/zhongyy40/workspace/harnesscli/harness/dist/src/cli.js preflight gate --dir contracts --config harness.config.json --json
```

Expected: exit code `1`, JSON outcome `not_ready`, readiness error `gateSetup.1.nvm`. This static failure path must not require `DAYTONA_API_KEY`.

- [ ] **Step 3: Optional real Daytona preflight**

Run only when `DAYTONA_API_KEY` is available and the local or remote Daytona service is intended to be used:

```bash
cd /Users/zhongyy40/workspace/harnesscli/harness
env | rg '^(DAYTONA_API_KEY|DAYTONA_API_URL|HARNESS_DAYTONA_GATE_SNAPSHOT)='
node dist/src/cli.js preflight gate --dir examples/contracts --config examples/harness.config.json --json
```

Expected: either `ready` or product-red failures with zero `readinessErrors`. If examples contain sample HTTP contracts that intentionally fail, record that they are product failures, not Gate runtime errors.

- [ ] **Step 4: Check final git status**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: working tree is clean after all planned commits, and recent commits match the task commits above.

- [ ] **Step 5: Final summary**

Report:

- local `npm run check` result;
- whether optional Daytona probe ran;
- any readiness/product-red distinction observed;
- exact commits created.

No commit is needed for this task if no files changed.

---

## Self-Review Checklist

- Spec coverage:
  - Static lint is covered by Task 1.
  - Runtime Gate sandbox rehearsal is covered by Task 2.
  - CLI command and exit codes are covered by Task 3.
  - Skill/scaffold guidance is covered by Task 4.
  - User docs and architecture boundaries are covered by Task 5.
  - Full local and optional Daytona verification are covered by Task 6.
- Type consistency:
  - `GatePreflightReport`, `PreflightFinding`, and `PreflightStep` are introduced in Task 1 and reused consistently.
  - `runGatePreflight()` is introduced in Task 2 and used by CLI in Task 3.
  - Renderers are introduced before `src/index.ts` exports them.
- Scope:
  - The first release keeps `harness run` behavior unchanged.
  - Host-local gates are reported as not Gate-covered; a separate host preflight is left for a later release.
  - `--allow-red-gates` and persisted preflight records are not included in this implementation.

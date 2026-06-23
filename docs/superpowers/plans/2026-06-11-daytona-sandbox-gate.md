# Daytona Sandbox Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Harness agent work in a persistent Daytona sandbox, evaluate every candidate in a fresh agent-free Daytona sandbox, and let only the host-controlled `GateCore` publish a passing candidate.

**Architecture:** Capture the current Git worktree as a host-owned baseline, expose only allowed files to a persistent agent sandbox, and compute candidate changes by downloading and hashing sandbox files on the host. For each attempt, assemble a new gate sandbox and keep contracts, verdicts, plugin classification, aggregation, retry, escalation, and publication in the host process while command and HTTP evidence is collected remotely.

**Tech Stack:** TypeScript, Node.js 20+, Node test runner, `@daytona/sdk` 0.186.0, Claude Code, existing Harness gate plugins.

---

## File Structure

### New Files

- `src/harness/execution.ts`
  - Defines raw command/HTTP evidence and local/remote execution-target contracts.
  - Provides the existing host execution behavior as `localExecutionTarget`.
- `src/harness/sandbox/types.ts`
  - Defines sandbox policy, workspace manifests, candidate operations, sandbox provider interfaces, and publication results.
- `src/harness/sandbox/policy.ts`
  - Loads and normalizes `harness.config.json` sandbox policy.
  - Enforces candidate roots, protected paths, path normalization, and size limits.
- `src/harness/sandbox/workspace.ts`
  - Captures the Git worktree baseline.
  - Collects remote candidate bytes through an injected filesystem.
  - Computes add/modify/delete/mode operations without trusting sandbox Git.
- `src/harness/sandbox/publish.ts`
  - Checks host baseline preconditions and atomically publishes an accepted candidate.
- `src/harness/sandbox/daytona.ts`
  - Wraps `@daytona/sdk` behind injected provider and sandbox-handle interfaces.
  - Owns local API configuration, proxy bypass, upload/download, PTY, and cleanup.
- `src/harness/sandbox/environment.ts`
  - Implements the persistent agent sandbox plus fresh gate sandbox lifecycle.
  - Runs host `GateCore` against a Daytona execution target.
- `test/remote-gate.test.ts`
  - Verifies plugins classify remote raw evidence on the host.
- `test/sandbox-policy.test.ts`
  - Verifies path and policy enforcement.
- `test/sandbox-workspace.test.ts`
  - Verifies baseline capture, candidate collection, diffing, and publication conflicts.
- `test/daytona-sandbox.test.ts`
  - Verifies the Daytona adapter using injected fakes.
- `test/daytona-environment.test.ts`
  - Verifies persistent agent and fresh gate lifecycle without a real Daytona service.

### Modified Files

- `src/contracts.ts`
  - Recursively canonicalizes nested contracts before hashing.
- `src/types.ts`
  - Adds an optional host-owned execution target to `RunContext`.
- `src/plugins/command.ts`
- `src/plugins/boot.ts`
- `src/plugins/structure.ts`
- `src/plugins/http.ts`
  - Use `RunContext.execution` and classify returned raw evidence.
- `src/harness/drivers.ts`
  - Keeps scaffold behavior and converts driver selection into an agent command specification.
  - Marks direct host Claude execution as unsafe/internal compatibility behavior.
- `src/harness/run.ts`
  - Runs through a `RunEnvironment`, publishes only after gate pass, and preserves retry/escalation semantics.
- `src/cli.ts`
  - Builds a Daytona environment for `claude` and `command`.
  - Loads sandbox policy and removes silent host execution.
- `src/index.ts`
  - Exports the new execution and sandbox APIs.
- `src/harness/scaffold.ts`
  - Generates explicit sandbox policy in new projects.
- `test/loader-selector.test.ts`
- `test/adapters.test.ts`
- `test/harness-run.test.ts`
- `test/claude-driver.test.ts`
  - Cover the changed contracts and environment APIs.
- `test/daytona-claude.ts`
- `test/daytona-claude.test.ts`
  - Migrate the exploration into production adapter coverage and an opt-in integration flow.
- `package.json`
  - Adds an explicit Daytona integration-test script.
- `README.md`
- `docs/daytona-local-claude-code-runbook.md`
  - Document the production flow, policy, trust boundary, and integration test.

## Task 1: Fix Recursive Frozen-Contract Hashing

**Files:**
- Modify: `src/contracts.ts`
- Test: `test/loader-selector.test.ts`

- [ ] **Step 1: Add a failing nested-tampering test**

Add this test after the existing freeze tests:

```ts
test("freeze + verify: 篡改嵌套 expect 字段后校验失败", () => {
  const frozen = freezeContract({
    id: "nested",
    type: "http",
    trigger: { method: "GET", path: "/health" },
    expect: { status: 200, body_contains: { ready: true } },
  });

  const tampered: Contract = {
    ...frozen,
    expect: { status: 500, body_contains: { ready: true } },
  };

  assert.equal(verifyFrozen(frozen).ok, true);
  assert.equal(verifyFrozen(tampered).ok, false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build && node --test dist/test/loader-selector.test.js
```

Expected: FAIL because changing `expect.status` currently produces the same hash.

- [ ] **Step 3: Implement recursive canonical JSON**

Add a JSON-compatible canonicalizer and use it in `contractHash`:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new TypeError(`契约包含不可哈希值: ${typeof value}`);
}

export function contractHash(c: Contract): string {
  const { frozen, frozen_at, hash, ...rest } = c as Record<string, unknown>;
  void frozen;
  void frozen_at;
  void hash;
  const canonical = JSON.stringify(canonicalize(rest));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
npm run build
node --test dist/test/loader-selector.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts test/loader-selector.test.ts
git commit -m "fix: hash nested frozen contract fields"
```

## Task 2: Introduce Host-Owned Execution Evidence

**Files:**
- Create: `src/harness/execution.ts`
- Modify: `src/types.ts`
- Modify: `src/plugins/command.ts`
- Modify: `src/plugins/boot.ts`
- Modify: `src/plugins/structure.ts`
- Modify: `src/plugins/http.ts`
- Create: `test/remote-gate.test.ts`
- Modify: `test/adapters.test.ts`

- [ ] **Step 1: Write failing tests for remote command evidence**

Create `test/remote-gate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { GateCore } from "../src/gate.js";
import { commandPlugin } from "../src/plugins/command.js";
import type { ExecutionTarget } from "../src/harness/execution.js";

test("command gate is classified by host from remote raw evidence", async () => {
  const calls: unknown[] = [];
  const execution: ExecutionTarget = {
    async execute(request) {
      calls.push(request);
      return {
        executionId: request.executionId,
        exitCode: 0,
        stdout: "candidate says anything",
        stderr: "",
        durationMs: 12,
      };
    },
    async request() {
      throw new Error("not used");
    },
  };

  // "/workspace/candidate" is the Harness logical cwd. In a Daytona
  // interactive shell, the same workspace appears at
  // /home/daytona/workspace/candidate.
  const report = await new GateCore().use(commandPlugin).run(
    [{ id: "trusted", type: "command", cmd: "node", args: ["trusted-test.js"] }],
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(report.outcome, "pass");
  assert.equal(calls.length, 1);
  const request = calls[0] as {
    executionId: string;
    command: string;
    args: string[];
    cwd: string;
  };
  assert.ok(request.executionId);
  assert.equal(request.command, "node");
  assert.deepEqual(request.args, ["trusted-test.js"]);
  assert.equal(request.cwd, "/workspace/candidate");
});

test("mismatched execution id is error, never pass", async () => {
  const execution: ExecutionTarget = {
    async execute() {
      return {
        executionId: "forged",
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        durationMs: 1,
      };
    },
    async request() {
      throw new Error("not used");
    },
  };

  const report = await new GateCore().use(commandPlugin).run(
    [{ id: "trusted", type: "command", cmd: "true" }],
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(report.results[0]?.status, "error");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npm run build
```

Expected: TypeScript errors because `ExecutionTarget` and
`RunContext.execution` do not exist.

- [ ] **Step 3: Define evidence and execution-target interfaces**

Create `src/harness/execution.ts`:

```ts
import { randomUUID } from "node:crypto";
import { spawnCapture } from "../util/spawn.js";

export interface CommandExecutionRequest {
  executionId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandExecutionEvidence {
  executionId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface HttpExecutionRequest {
  executionId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpExecutionEvidence {
  executionId: string;
  status?: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  error?: string;
}

export interface ExecutionTarget {
  execute(request: CommandExecutionRequest): Promise<CommandExecutionEvidence>;
  request(request: HttpExecutionRequest): Promise<HttpExecutionEvidence>;
}

export function executionId(): string {
  return randomUUID();
}

export const localExecutionTarget: ExecutionTarget = {
  async execute(request) {
    const start = performance.now();
    const result = await spawnCapture(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
    });
    return {
      executionId: request.executionId,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: performance.now() - start,
      ...(result.spawnError ? { error: result.spawnError } : {}),
    };
  },
  async request(request) {
    const start = performance.now();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.timeoutMs
          ? AbortSignal.timeout(request.timeoutMs)
          : undefined,
      });
      return {
        executionId: request.executionId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
        durationMs: performance.now() - start,
      };
    } catch (error) {
      return {
        executionId: request.executionId,
        headers: {},
        body: "",
        durationMs: performance.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
```

Add to `RunContext`:

```ts
import type { ExecutionTarget } from "./harness/execution.js";

export interface RunContext {
  cwd: string;
  verdicts?: Record<string, Verdict>;
  signal?: AbortSignal;
  execution?: ExecutionTarget;
}
```

- [ ] **Step 4: Make command-like plugins classify evidence on the host**

For each plugin, select the target with:

```ts
const execution = ctx.execution ?? localExecutionTarget;
const id = executionId();
const evidence = await execution.execute({
  executionId: id,
  command: cmd,
  args,
  cwd: ctx.cwd,
});

if (evidence.executionId !== id) {
  return {
    id: contract.id,
    type: this.type,
    status: "error",
    durationMs: evidence.durationMs,
    violations: [],
    errorReason: "执行证据 ID 不匹配，结果不可信 ⇒ error",
  };
}
if (evidence.error) {
  return {
    id: contract.id,
    type: this.type,
    status: "error",
    durationMs: evidence.durationMs,
    violations: [],
    errorReason: `命令无法执行: ${evidence.error} ⇒ error`,
  };
}
```

Use `evidence.exitCode`, `stdout`, `stderr`, and `durationMs` for the existing
classification. Do not let the execution target return `CheckResult`.

For `httpPlugin`, call `execution.request` with a host-generated ID and classify
`status`, headers, and body exactly as the current plugin classifies `fetch`.

- [ ] **Step 5: Run focused plugin tests**

Run:

```bash
npm run build
node --test dist/test/remote-gate.test.js
node --test dist/test/adapters.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/harness/execution.ts src/types.ts src/plugins/command.ts \
  src/plugins/boot.ts src/plugins/structure.ts src/plugins/http.ts \
  test/remote-gate.test.ts test/adapters.test.ts
git commit -m "refactor: classify remote gate evidence on host"
```

## Task 3: Define Sandbox Policy And Path Enforcement

**Files:**
- Create: `src/harness/sandbox/types.ts`
- Create: `src/harness/sandbox/policy.ts`
- Create: `test/sandbox-policy.test.ts`
- Modify: `examples/harness.config.json`

- [ ] **Step 1: Write failing policy tests**

Create `test/sandbox-policy.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadSandboxPolicy,
  normalizeWorkspacePath,
  validateCandidatePath,
} from "../src/harness/sandbox/policy.js";

test("candidate path must be relative and inside an allowed root", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: [
        "src",
        "test/generated",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
      ],
      protectedPaths: ["src/gates", "contracts"],
    },
  });

  assert.equal(validateCandidatePath("src/app.ts", policy), "src/app.ts");
  assert.throws(() => validateCandidatePath("../secret", policy), /越界/);
  assert.throws(() => validateCandidatePath("/etc/passwd", policy), /绝对路径/);
  assert.throws(() => validateCandidatePath("README.md", policy), /允许范围/);
  assert.throws(() => validateCandidatePath("src/gates/judge.ts", policy), /受保护/);
});

test("normalization rejects ambiguous path spellings", () => {
  assert.equal(normalizeWorkspacePath("src/a.ts"), "src/a.ts");
  assert.throws(() => normalizeWorkspacePath("src//a.ts"), /非法路径/);
  assert.throws(() => normalizeWorkspacePath("src/./a.ts"), /非法路径/);
  assert.throws(() => normalizeWorkspacePath("src\\a.ts"), /非法路径/);
});
```

- [ ] **Step 2: Run build and verify RED**

Run:

```bash
npm run build
```

Expected: missing sandbox policy modules.

- [ ] **Step 3: Add policy and workspace types**

Create `src/harness/sandbox/types.ts` with:

```ts
export interface SandboxLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface SandboxPolicy {
  candidateRoots: string[];
  protectedPaths: string[];
  agentSetup: string[];
  gateSetup: string[];
  limits: SandboxLimits;
  retainOnFailure: boolean;
}

export interface WorkspaceFile {
  path: string;
  content: Buffer;
  executable: boolean;
  sha256: string;
}

export interface WorkspaceSnapshot {
  root: string;
  files: Map<string, WorkspaceFile>;
}

export type CandidateOperation =
  | { kind: "add"; file: WorkspaceFile }
  | { kind: "modify"; before: WorkspaceFile; file: WorkspaceFile }
  | { kind: "delete"; before: WorkspaceFile };

export interface CandidateSnapshot {
  operations: CandidateOperation[];
  files: Map<string, WorkspaceFile>;
}
```

- [ ] **Step 4: Implement strict policy normalization**

In `policy.ts`, define conservative defaults and prefix checks:

```ts
const DEFAULT_POLICY: SandboxPolicy = {
  candidateRoots: [
    "src",
    "lib",
    "test/generated",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ],
  protectedPaths: [
    "contracts",
    ".harness",
    "harness.config.json",
    ".github/workflows",
    "CODEOWNERS",
  ],
  agentSetup: [],
  gateSetup: [],
  limits: {
    maxFiles: 10_000,
    maxFileBytes: 10 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
  },
  retainOnFailure: false,
};

function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function normalizeWorkspacePath(value: string): string {
  if (value.startsWith("/")) throw new Error(`绝对路径不允许: ${value}`);
  if (
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`非法路径或越界路径: ${value}`);
  }
  return value;
}

export function validateCandidatePath(
  value: string,
  policy: SandboxPolicy,
): string {
  const path = normalizeWorkspacePath(value);
  if (!policy.candidateRoots.some((root) => isWithin(path, root))) {
    throw new Error(`候选路径不在允许范围: ${path}`);
  }
  if (policy.protectedPaths.some((root) => isWithin(path, root))) {
    throw new Error(`候选路径属于受保护资产: ${path}`);
  }
  return path;
}
```

`loadSandboxPolicy` must merge only known fields, normalize every configured
path, reject overlapping candidate/protected roots that make all candidate
content inaccessible, and require positive integer limits.

- [ ] **Step 5: Update the example configuration**

Add this top-level field without changing existing selector behavior:

```json
"sandbox": {
  "candidateRoots": [
    "src",
    "test/generated",
    "package.json",
    "package-lock.json",
    "tsconfig.json"
  ],
  "protectedPaths": [
    "contracts",
    ".harness",
    "harness.config.json",
    ".github/workflows",
    "CODEOWNERS",
    "test/gates"
  ],
  "agentSetup": [],
  "gateSetup": [],
  "limits": {
    "maxFiles": 10000,
    "maxFileBytes": 10485760,
    "maxTotalBytes": 209715200
  },
  "retainOnFailure": false
}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run build
node --test dist/test/sandbox-policy.test.js
```

Expected: PASS.

Commit:

```bash
git add src/harness/sandbox/types.ts src/harness/sandbox/policy.ts \
  test/sandbox-policy.test.ts examples/harness.config.json
git commit -m "feat: define sandbox candidate policy"
```

## Task 4: Capture, Collect, Diff, And Publish Exact Candidate Bytes

**Files:**
- Create: `src/harness/sandbox/workspace.ts`
- Create: `src/harness/sandbox/publish.ts`
- Create: `test/sandbox-workspace.test.ts`

- [ ] **Step 1: Write failing host-diff tests**

Create tests that use a temporary Git repository and a fake remote filesystem:

```ts
test("collector computes changes from downloaded bytes and ignores sandbox git", async () => {
  const host = createGitFixture({
    "src/a.ts": "before\n",
    "src/delete.ts": "remove\n",
    "contracts/gate.yaml": "id: gate\n",
  });
  const baseline = captureWorkspace(host, policy());
  const remote = fakeRemoteFiles({
    "src/a.ts": "after\n",
    "src/new.ts": "new\n",
  });

  const candidate = await collectCandidate(remote, baseline, policy());

  assert.deepEqual(
    candidate.operations.map((operation) => [
      operation.kind,
      "file" in operation ? operation.file.path : operation.before.path,
    ]),
    [
      ["modify", "src/a.ts"],
      ["delete", "src/delete.ts"],
      ["add", "src/new.ts"],
    ],
  );
});

test("collector rejects symlink and oversized files", async () => {
  const baseline = captureWorkspace(createGitFixture({ "src/a.ts": "a" }), policy());
  await assert.rejects(
    () => collectCandidate(fakeRemoteEntries([
      { path: "src/link", kind: "symlink", size: 1 },
    ]), baseline, policy()),
    /符号链接|文件类型/,
  );
});

test("publisher detects concurrent host changes and writes nothing", () => {
  const host = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(host, policy());
  const candidate = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  writeFileSync(join(host, "src/a.ts"), "concurrent\n");

  const result = publishCandidate(baseline, candidate, policy());

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(host, "src/a.ts"), "utf8"), "concurrent\n");
});
```

Define the test helpers in the same file:

```ts
function policy(): SandboxPolicy {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
    },
  });
}

function createGitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-workspace-"));
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

function fakeRemoteFiles(files: Record<string, string>): RemoteWorkspace {
  const entries = new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      {
        entry: {
          path,
          kind: "file" as const,
          size: Buffer.byteLength(content),
          executable: false,
        },
        content: Buffer.from(content),
      },
    ]),
  );
  return {
    async list() {
      return [...entries.values()].map(({ entry }) => entry);
    },
    async read(path) {
      const found = entries.get(path);
      if (!found) throw new Error(`missing fake file: ${path}`);
      return found.content;
    },
  };
}

function fakeRemoteEntries(entries: RemoteFileEntry[]): RemoteWorkspace {
  return {
    async list() {
      return entries;
    },
    async read() {
      return Buffer.from("x");
    },
  };
}

function candidateReplacing(
  baseline: WorkspaceSnapshot,
  path: string,
  content: string,
): CandidateSnapshot {
  const before = baseline.files.get(path);
  if (!before) throw new Error(`missing baseline file: ${path}`);
  const file = workspaceFile(path, Buffer.from(content), before.executable);
  return {
    files: new Map([[path, file]]),
    operations: [{ kind: "modify", before, file }],
  };
}
```

- [ ] **Step 2: Run build and verify RED**

Run:

```bash
npm run build
```

Expected: missing workspace and publication modules.

- [ ] **Step 3: Implement Git baseline capture**

Define the injected remote interface:

```ts
export interface RemoteFileEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "special";
  size: number;
  executable: boolean;
}

export interface RemoteWorkspace {
  list(root: string): Promise<RemoteFileEntry[]>;
  read(path: string): Promise<Buffer>;
}
```

Implement `captureWorkspace(root, policy)` by:

1. running `git -C <root> rev-parse --is-inside-work-tree`;
2. running `git -C <root> ls-files -co --exclude-standard -z`;
3. rejecting paths outside the repository root and all symbolic/special files;
4. reading exact bytes and executable bits;
5. hashing with full SHA-256;
6. storing protected and mutable files in one host snapshot while exposing a
   helper that returns only agent-visible files.

Create file records through one function so host and remote hashes use the
same algorithm:

```ts
export function workspaceFile(
  path: string,
  content: Buffer,
  executable: boolean,
): WorkspaceFile {
  return {
    path,
    content,
    executable,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
```

Export the helper with this exact contract:

```ts
export function agentVisibleFiles(
  snapshot: WorkspaceSnapshot,
  policy: SandboxPolicy,
): WorkspaceFile[] {
  return [...snapshot.files.values()]
    .filter((file) => {
      try {
        validateCandidatePath(file.path, policy);
        return true;
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
```

Do not include `.git`, ignored `.harness`, `node_modules`, or `dist` unless they
are explicitly tracked.

- [ ] **Step 4: Implement host-side candidate collection**

`collectCandidate` must:

```ts
// "/workspace/candidate" is the Harness logical remote root, not a root-level
// directory to inspect from an interactive Daytona shell.
for (const entry of await remote.list("/workspace/candidate")) {
  const path = validateCandidatePath(entry.path, policy);
  if (entry.kind !== "file") {
    throw new Error(`候选包含不支持的文件类型: ${path} (${entry.kind})`);
  }
  if (entry.size > policy.limits.maxFileBytes) {
    throw new Error(`候选文件超过大小限制: ${path}`);
  }
  const content = await remote.read(path);
  if (content.byteLength !== entry.size) {
    throw new Error(`候选文件读取大小不一致: ${path}`);
  }
  // Hash bytes locally and build the current mutable file map.
}
```

After collection, compare the current mutable map with the mutable portion of
the baseline. Sort operations by path for deterministic tests. Never inspect
or use sandbox `.git`.

- [ ] **Step 5: Implement fail-closed publication**

`publishCandidate` must first validate every operation and every host
precondition. Only after all preconditions pass may it write:

```ts
export interface PublicationResult {
  ok: boolean;
  changedFiles: string[];
  conflict?: string;
}
```

For add/modify:

```ts
const temporary = `${destination}.harness-${randomUUID()}.tmp`;
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(temporary, operation.file.content, { mode: operation.file.executable ? 0o755 : 0o644 });
renameSync(temporary, destination);
```

For deletes, verify the current file still matches `before.sha256`, then remove
it only after every operation has passed preflight. Recheck protected paths
during preflight.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run build
node --test dist/test/sandbox-workspace.test.js
```

Expected: PASS.

Commit:

```bash
git add src/harness/sandbox/workspace.ts src/harness/sandbox/publish.ts \
  test/sandbox-workspace.test.ts
git commit -m "feat: collect and publish host-owned candidates"
```

## Task 5: Move Daytona Exploration Behind A Production Adapter

**Files:**
- Create: `src/harness/sandbox/daytona.ts`
- Create: `test/daytona-sandbox.test.ts`
- Modify: `test/daytona-claude.ts`
- Modify: `test/daytona-claude.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Cover configuration, proxy bypass, environment filtering, lifecycle labels,
and no model credentials in gate creation:

```ts
test("agent sandbox receives model environment but gate sandbox does not", async () => {
  const created: Array<Record<string, unknown>> = [];
  const provider = fakeDaytonaProvider(created);
  const manager = createDaytonaManager({
    provider,
    environment: completeEnvironment(),
  });

  await manager.createAgentSandbox();
  await manager.createGateSandbox();

  assert.equal(created[0]?.labels?.["harness.role"], "agent");
  assert.ok((created[0]?.envVars as Record<string, string>).ANTHROPIC_AUTH_TOKEN);
  assert.equal(created[1]?.labels?.["harness.role"], "gate");
  assert.deepEqual(created[1]?.envVars, {});
});

test("missing Daytona key fails before sandbox creation", async () => {
  const provider = fakeDaytonaProvider([]);
  assert.throws(
    () => createDaytonaManager({ provider, environment: {} }),
    /DAYTONA_API_KEY/,
  );
});
```

- [ ] **Step 2: Run build and verify RED**

Run:

```bash
npm run build
```

Expected: missing production Daytona adapter.

- [ ] **Step 3: Define injected Daytona interfaces**

In `types.ts`, add focused interfaces instead of exposing SDK classes:

```ts
export interface SandboxCreateRequest {
  role: "agent" | "gate";
  envVars: Record<string, string>;
  ephemeral: boolean;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  readonly id: string;
  upload(files: WorkspaceFile[], remoteRoot: string): Promise<void>;
  workspace(remoteRoot: string): RemoteWorkspace;
  execute(command: string, cwd: string, env?: Record<string, string>): Promise<SandboxCommandResult>;
  runPty(command: string, cwd: string, env: Record<string, string>): Promise<SandboxCommandResult>;
  delete(): Promise<void>;
}

export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
}
```

- [ ] **Step 4: Implement the SDK wrapper**

Move these validated behaviors from `test/daytona-claude.ts`:

- `DAYTONA_API_URL` defaults to `http://localhost:3000/api`;
- require `DAYTONA_API_KEY`;
- append `localhost`, `127.0.0.1`, `.localhost`, and `proxy.localhost` to both
  `NO_PROXY` and `no_proxy`;
- pass only the explicit Anthropic/model variables to agent PTY;
- install Claude Code under `$HOME/.local`;
- use SDK file APIs for uploads/downloads;
- create agent labels `{ "harness.role": "agent" }`;
- create gate labels `{ "harness.role": "gate" }`;
- create gate sandboxes with empty `envVars`;
- delete through the SDK handle.

Use:

```ts
const sandbox = await daytona.create({
  language: "typescript",
  labels: { "harness.role": request.role },
  envVars: request.envVars,
  ephemeral: request.ephemeral,
});
```

Map `FileInfo.mode` to regular/directory/symlink/special conservatively. Unknown
mode values must become `special`, not regular files.

- [ ] **Step 5: Convert exploration tests**

Keep pure configuration tests in `test/daytona-claude.test.ts`, but import
helpers from `src/harness/sandbox/daytona.ts`.

Change `test/daytona-claude.ts` into an explicit integration helper that calls
the production manager. It must not run during normal `npm test`.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run build
node --test dist/test/daytona-sandbox.test.js
node --test dist/test/daytona-claude.test.js
```

Expected: PASS without a Daytona service.

Commit:

```bash
git add src/harness/sandbox/daytona.ts src/harness/sandbox/types.ts \
  test/daytona-sandbox.test.ts test/daytona-claude.ts \
  test/daytona-claude.test.ts
git commit -m "feat: add injectable Daytona sandbox adapter"
```

## Task 6: Implement Persistent Agent And Fresh Gate Environment

**Files:**
- Create: `src/harness/sandbox/environment.ts`
- Modify: `src/harness/run.ts`
- Create: `test/daytona-environment.test.ts`
- Modify: `test/harness-run.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use fake provider handles and a real fake `GateCore` plugin:

```ts
test("multiple attempts reuse one agent and create a fresh gate each time", async () => {
  const provider = scriptedProvider({
    gateExitCodes: [1, 0],
    candidateVersions: ["broken", "fixed"],
  });
  const environment = await createDaytonaRunEnvironment({
    provider,
    root: fixture.root,
    policy: fixture.policy,
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "gate", type: "command", cmd: "trusted-test" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: fixture.root },
    environment,
    budget: budget({ maxAttempts: 3 }),
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(provider.createdByRole("agent"), 1);
  assert.equal(provider.createdByRole("gate"), 2);
  assert.equal(provider.agentPrompts.length, 2);
  assert.match(provider.agentPrompts[1]!, /门禁反馈/);
});

test("gate sandbox never receives agent installation or model credentials", async () => {
  // Run one attempt, then inspect fake gate handle commands and environment.
  assert.deepEqual(gate.envVars, {});
  assert.equal(gate.commands.some((command) => command.includes("claude")), false);
});
```

- [ ] **Step 2: Run build and verify RED**

Run:

```bash
npm run build
```

Expected: missing run-environment API.

- [ ] **Step 3: Define the run-environment boundary**

In `run.ts`, replace direct driver ownership with:

```ts
export interface RunEnvironment {
  readonly name: string;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  runGate(input: {
    contracts: Contract[];
    gate: GateCore;
    ctx: RunContext;
  }): Promise<GateReport>;
  publish(): Promise<PublicationResult>;
  close(): Promise<void>;
}
```

Update `RunOptions` to require `environment` and remove `driver`. Preserve a
small `localRunEnvironment(driver, cwd)` adapter only for scaffold tests and
non-mutating compatibility paths.

- [ ] **Step 4: Implement agent initialization and reuse**

`createDaytonaRunEnvironment` captures the host baseline once. On first
`runTask`:

1. create one agent sandbox;
2. upload only agent-visible baseline files;
3. run configured `agentSetup`;
4. install Claude Code once for `kind: "claude"`.

Each Claude attempt runs:

```sh
exec "$HOME/.local/bin/claude" \
  --dangerously-skip-permissions \
  -p "$HARNESS_PROMPT" \
  --output-format stream-json \
  --verbose
```

Pass `HARNESS_PROMPT` and model variables through PTY environment, not command
string interpolation. For later attempts, include sanitized host feedback in
`HARNESS_PROMPT`.

For `kind: "command"`, execute the configured host-supplied command at the
Harness logical root `/workspace/candidate` with `HARNESS_TASK` and
`HARNESS_FEEDBACK`. Daytona receives SDK path `workspace/candidate`; in an
interactive shell this appears as `/home/daytona/workspace/candidate`.

- [ ] **Step 5: Implement one fresh gate attempt**

`runGate` must:

1. collect exact candidate bytes from the persistent agent sandbox;
2. store that candidate as `pendingCandidate`;
3. create one new gate sandbox with no model environment;
4. upload the complete host baseline;
5. apply candidate operations;
6. run configured gate setup;
7. restore protected assets from the host baseline;
8. construct an `ExecutionTarget` backed by the gate handle;
9. call host `gate.run(contracts, { ...ctx, cwd: "/workspace/candidate", execution })`
   using the Harness logical cwd; Daytona resolves it via SDK path
   `workspace/candidate`, visible in shell as
   `/home/daytona/workspace/candidate`;
10. delete the gate sandbox in `finally`.

If candidate policy validation fails, return a synthetic error report through
this helper:

```ts
function candidateIntegrityReport(reason: string): GateReport {
  return aggregate([{
    id: "harness.candidate-integrity",
    type: "harness",
    status: "error",
    durationMs: 0,
    violations: [],
    errorReason: reason,
  }]);
}
```

If gate sandbox cleanup fails after an otherwise passing report, replace it
with an error report so publication cannot occur.

- [ ] **Step 6: Publish only the evaluated pending candidate**

After `runGate` returns `pass`, `publish()` must call `publishCandidate` with
the retained `pendingCandidate`. It must not recollect files from the live
agent sandbox.

Update `runLoop`:

```ts
const act = await o.environment.runTask({ task: o.task, feedback });
const report = await o.environment.runGate({
  contracts: o.contracts,
  gate: o.gate,
  ctx: o.ctx,
});

if (report.outcome === "pass") {
  const publication = await o.environment.publish();
  if (!publication.ok) {
    return {
      outcome: "escalated",
      attempts: state.attempts,
      report,
      action: {
        kind: "stop_for_human",
        reason: publication.conflict ?? "候选发布失败",
      },
      logs,
    };
  }
  return { outcome: "ready_for_mr", attempts: state.attempts, report, logs };
}
```

Always call `environment.close()` in `finally`.

- [ ] **Step 7: Run lifecycle tests and commit**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
node --test dist/test/harness-run.test.js
```

Expected: PASS.

Commit:

```bash
git add src/harness/sandbox/environment.ts src/harness/run.ts \
  test/daytona-environment.test.ts test/harness-run.test.ts
git commit -m "feat: run agent and gates in isolated Daytona environments"
```

## Task 7: Implement Daytona Remote Execution Target

**Files:**
- Modify: `src/harness/sandbox/daytona.ts`
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `test/daytona-sandbox.test.ts`
- Modify: `test/remote-gate.test.ts`

- [ ] **Step 1: Write failing command-protocol tests**

Add tests for quoting, evidence IDs, bounded output, and HTTP requests:

```ts
// "/workspace/candidate" is the Harness logical cwd. Daytona SDK resolves it as
// "workspace/candidate", visible in shell as /home/daytona/workspace/candidate.
test("remote command preserves trusted argv and execution id", async () => {
  const handle = recordingSandbox({
    exitCode: 7,
    stdout: "out",
    stderr: "err",
  });
  const target = createDaytonaExecutionTarget(handle, "/workspace/candidate");

  const evidence = await target.execute({
    executionId: "host-id",
    command: "node",
    args: ["test file.js", "a'b"],
    cwd: "/workspace/candidate",
  });

  assert.equal(evidence.executionId, "host-id");
  assert.equal(evidence.exitCode, 7);
  assert.match(handle.commands[0]!, /^\/usr\/bin\/env -- /);
  assert.match(handle.commands[0]!, /'test file\.js'/);
  assert.match(handle.commands[0]!, /'a'\"'\"'b'/);
});
```

Add a fake HTTP response test where the sandbox returns a JSON envelope and
assert that malformed JSON produces `error` evidence rather than throwing a
passing result.

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
npm run build && node --test dist/test/daytona-sandbox.test.js
```

Expected: missing remote execution target or incorrect protocol behavior.

- [ ] **Step 3: Implement POSIX argument encoding and evidence limits**

Use an internal quote function:

```ts
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function commandLine(command: string, args: string[]): string {
  return ["/usr/bin/env", "--", command, ...args].map(quotePosix).join(" ");
}
```

The adapter must use the host request's `executionId` in returned evidence,
because the sandbox never decides the ID. Truncate stdout and stderr to a
configured maximum, marking truncation in the text.

- [ ] **Step 4: Implement HTTP evidence collection inside gate sandbox**

Execute a fixed Node script with the request JSON in an environment variable:

```js
const request = JSON.parse(process.env.HARNESS_HTTP_REQUEST);
const response = await fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body,
  signal: AbortSignal.timeout(request.timeoutMs ?? 30000),
});
process.stdout.write(JSON.stringify({
  status: response.status,
  headers: Object.fromEntries(response.headers.entries()),
  body: await response.text(),
}));
```

The host adapter parses the envelope and returns `HttpExecutionEvidence`. A
nonzero exit, invalid JSON, or missing fields becomes `error`.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run build
node --test dist/test/daytona-sandbox.test.js
node --test dist/test/remote-gate.test.js
```

Expected: PASS.

Commit:

```bash
git add src/harness/sandbox/daytona.ts src/harness/sandbox/environment.ts \
  test/daytona-sandbox.test.ts test/remote-gate.test.ts
git commit -m "feat: collect gate evidence through Daytona"
```

## Task 8: Wire CLI Run And Fix To Daytona By Default

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/harness/drivers.ts`
- Modify: `src/index.ts`
- Modify: `test/claude-driver.test.ts`
- Modify: `test/harness-run.test.ts`

- [ ] **Step 1: Write failing CLI-selection unit tests**

Extract and export a pure agent-spec selector from `drivers.ts`:

```ts
test("claude and command selections require isolated execution specs", () => {
  assert.deepEqual(selectAgent({ driver: "claude" }), { kind: "claude" });
  assert.deepEqual(
    selectAgent({ driver: "command", "agent-cmd": "my-agent --flag" }),
    { kind: "command", command: "my-agent --flag" },
  );
});
```

Add a test that missing `DAYTONA_API_KEY` for a Claude run reports a Daytona
configuration error and does not call the existing host Agent SDK query.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run build && node --test dist/test/claude-driver.test.js
```

Expected: missing `selectAgent` and CLI still returns a host driver.

- [ ] **Step 3: Replace CLI driver construction with environment construction**

Change `pickDriver` to a pure specification:

```ts
export type AgentSpec =
  | { kind: "scaffold" }
  | { kind: "claude" }
  | { kind: "command"; command: string };

export function selectAgent(values: Record<string, unknown>): AgentSpec {
  const kind = (values.driver as string) ?? "scaffold";
  if (kind === "command") {
    const command = values["agent-cmd"] as string | undefined;
    if (!command) throw new Error("--driver command 需要 --agent-cmd");
    return { kind: "command", command };
  }
  if (kind === "claude") return { kind: "claude" };
  if (kind === "scaffold") return { kind: "scaffold" };
  throw new Error(`未知 driver: ${kind}`);
}
```

In `doRun`:

1. load the sandbox policy from `--config` or `harness.config.json`;
2. use `localRunEnvironment(scaffoldDriver, cwd)` only for scaffold;
3. create `DaytonaRunEnvironment` for Claude and command specs;
4. print `environment=<name>` and the effective protected/candidate roots;
5. pass `environment` into `runLoop`.

Use `environment.name` for the console banner, budget selection, and
`RunRecord.driver` so persisted records describe the actual isolation mode.

Do not catch Daytona initialization errors and fall back to a host driver.

- [ ] **Step 4: Preserve observability without claiming host query tracing**

The current host `claudeDriver` Langfuse integration cannot wrap a Claude Code
process running in another sandbox. Keep it exported as
`unsafeLocalClaudeDriver` for compatibility tests, but remove it from normal
CLI selection and document it as unsafe.

Emit lifecycle observations for sandbox creation, agent command start/end,
candidate collection, gate creation, gate result, and cleanup through the
existing `onObservation` callback. Do not report that remote Claude messages
are instrumented by the host Agent SDK.

- [ ] **Step 5: Export the new public APIs**

From `src/index.ts`, export:

```ts
export {
  localExecutionTarget,
  type ExecutionTarget,
  type CommandExecutionEvidence,
  type HttpExecutionEvidence,
} from "./harness/execution.js";
export {
  loadSandboxPolicy,
  validateCandidatePath,
} from "./harness/sandbox/policy.js";
export {
  createDaytonaRunEnvironment,
} from "./harness/sandbox/environment.js";
```

- [ ] **Step 6: Run CLI and loop tests, then commit**

Run:

```bash
npm run build
node --test dist/test/claude-driver.test.js
node --test dist/test/harness-run.test.js
```

Expected: PASS.

Commit:

```bash
git add src/cli.ts src/harness/drivers.ts src/index.ts \
  test/claude-driver.test.ts test/harness-run.test.ts
git commit -m "feat: default agent runs to Daytona isolation"
```

## Task 9: Scaffold Policy And Add The Opt-In Integration Test

**Files:**
- Modify: `src/harness/scaffold.ts`
- Modify: `test/daytona-claude.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/daytona-local-claude-code-runbook.md`
- Test: `test/daytona-claude.test.ts`

- [ ] **Step 1: Write a failing scaffold test**

Add to the scaffold test coverage:

```ts
test("create writes explicit sandbox trust policy", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-"));
  createProject(target);
  const config = JSON.parse(
    readFileSync(join(target, "harness.config.json"), "utf8"),
  );

  assert.deepEqual(config.sandbox.candidateRoots, [
    "src",
    "test/generated",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]);
  assert.ok(config.sandbox.protectedPaths.includes("contracts"));
  assert.ok(config.sandbox.protectedPaths.includes("test/gates"));
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run the test file containing `createProject`.

Expected: FAIL because scaffolded config has no `sandbox` field.

- [ ] **Step 3: Add sandbox policy to generated projects**

Generate:

```ts
{
  baseline: ["smoke.boot"],
  rules: [{ when: ["src/**"], select: [] }],
  sandbox: {
    candidateRoots: [
      "src",
      "test/generated",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
    protectedPaths: [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates",
    ],
    agentSetup: [],
    gateSetup: [],
    limits: {
      maxFiles: 10_000,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 200 * 1024 * 1024,
    },
    retainOnFailure: false,
  },
}
```

- [ ] **Step 4: Make the real integration test explicit**

Change `test/daytona-claude.ts` so it:

1. exits with a clear skip message unless `RUN_DAYTONA_INTEGRATION=1`;
2. creates a temporary Git fixture with a trusted failing command contract;
3. runs one Claude attempt through `createDaytonaRunEnvironment`;
4. verifies that an agent sandbox and a separate gate sandbox were used;
5. deletes both sandboxes in `finally`;
6. never prints credentials.

Add:

```json
"test:daytona": "npm run build && RUN_DAYTONA_INTEGRATION=1 node dist/test/daytona-claude.js"
```

- [ ] **Step 5: Update documentation**

Document:

- required Daytona and Anthropic environment variables;
- `NO_PROXY` handling;
- persistent agent versus fresh gate sandbox;
- trusted host contracts and protected tests;
- candidate roots and size limits;
- no silent local fallback;
- publication only after pass;
- `npm run test:daytona`;
- the model-token limitation and use of short-lived credentials.

- [ ] **Step 6: Run focused and full tests, then commit**

Run:

```bash
npm run build
npm test
```

Expected: all unit tests pass without Daytona. Do not run `npm run
test:daytona` without configured local credentials.

Commit:

```bash
git add src/harness/scaffold.ts test/daytona-claude.ts \
  test/daytona-claude.test.ts package.json README.md \
  docs/daytona-local-claude-code-runbook.md
git commit -m "docs: ship Daytona sandbox gate workflow"
```

## Task 10: Verify Security Regressions And The Complete Flow

**Files:**
- Modify: `test/daytona-environment.test.ts`
- Modify: `test/sandbox-workspace.test.ts`
- Modify: `test/remote-gate.test.ts`

- [ ] **Step 1: Add abuse-case tests**

Add one focused test for each case:

```ts
test("agent-reported pass text cannot override failing gate evidence", async () => {
  // Agent stdout contains "all tests passed"; gate execution exits 1.
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.report.outcome, "fail");
});

test("protected contract bytes are never uploaded to agent sandbox", async () => {
  assert.equal(agent.uploadedPaths.includes("contracts/gate.yaml"), false);
});

test("gate sandbox is rebuilt from host baseline, not agent hidden files", async () => {
  assert.equal(gate.uploadedPaths.includes(".git/HEAD"), false);
  assert.equal(gate.read("contracts/gate.yaml"), trustedContractBytes);
});

test("candidate policy violation becomes gate error and is fed back", async () => {
  // Agent adds src/gates/forged-test.ts under a protected path.
  assert.equal(firstReport.results[0]?.status, "error");
  assert.match(secondAgentPrompt, /受保护资产/);
});

test("gate cleanup failure prevents publication", async () => {
  // Gate evidence passes, gate.delete rejects.
  assert.equal(outcome.outcome, "escalated");
  assert.equal(readHostCandidate(), "before");
});
```

- [ ] **Step 2: Run the security regression tests**

Run:

```bash
npm run build
node --test dist/test/daytona-environment.test.js
node --test dist/test/sandbox-workspace.test.js
node --test dist/test/remote-gate.test.js
```

Expected: PASS if Tasks 1-9 implemented every approved trust-boundary
requirement. A failure identifies the owning implementation boundary:

- agent upload filtering: `src/harness/sandbox/environment.ts`;
- candidate type/path validation: `src/harness/sandbox/workspace.ts`;
- host evidence classification: `src/harness/execution.ts` and gate plugins;
- cleanup fail-closed behavior: `src/harness/sandbox/environment.ts`;
- publication preconditions: `src/harness/sandbox/publish.ts`.

- [ ] **Step 3: Correct any failed trust-boundary assertion**

Apply only the matching correction below, then rerun Step 2:

- If a protected file reached the agent, change the agent upload list to
  `agentVisibleFiles(baseline, policy)` and assert every returned path passes
  `validateCandidatePath`.
- If a gate used agent-owned judge bytes, assemble the full host baseline first,
  apply only `pendingCandidate.operations`, then re-upload each protected file
  from `baseline.files` before constructing the execution target.
- If a cleanup failure allowed publication, catch `gate.delete()` failure and
  return `candidateIntegrityReport("gate sandbox cleanup failed: " + String(error))`.
- If agent text affected a verdict, remove that value from gate inputs; only
  `ExecutionTarget` evidence may enter plugin classification.
- If publication used live sandbox bytes, pass the retained
  `pendingCandidate` directly to `publishCandidate` and perform no remote read.
- If output is unbounded, truncate command stdout/stderr and HTTP body to
  1 MiB and feedback to 64 KiB before storing or forwarding it.

Do not add a second verdict path or allow sandbox-produced `CheckResult`.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm run check
git diff --check
git status --short
```

Expected:

- TypeScript build passes.
- All unit tests pass without Daytona.
- No whitespace errors.
- Only intended implementation and existing user changes remain.

- [ ] **Step 5: Run the real integration test when credentials are available**

Run:

```bash
npm run test:daytona
```

Expected:

- one persistent agent sandbox is created;
- at least one distinct gate sandbox is created;
- gate sandbox has no model credentials;
- host `GateCore` reports the result;
- candidate is published only after pass;
- sandboxes are deleted unless retention is enabled.

If credentials or the local Daytona service are unavailable, record that the
integration test was not run; do not weaken or skip unit assertions.

- [ ] **Step 6: Commit**

```bash
git add test/daytona-environment.test.ts test/sandbox-workspace.test.ts \
  test/remote-gate.test.ts
git commit -m "test: cover Daytona gate trust boundary"
```

## Final Review Checklist

- [ ] `contractHash` includes nested contract fields.
- [ ] Agent sandbox persists across retries.
- [ ] Gate sandbox is new for every attempt.
- [ ] Contracts, verdicts, invariant code, and aggregation remain on host.
- [ ] Agent sandbox Git and claimed results are ignored.
- [ ] Candidate bytes and hashes are computed on host.
- [ ] Protected paths never enter the agent sandbox.
- [ ] Gate sandbox receives no model credentials.
- [ ] Gate cleanup failure cannot produce `ready_for_mr`.
- [ ] Publication uses the exact evaluated candidate and detects concurrent edits.
- [ ] `harness run` and `harness fix` do not silently execute mutating agents locally.
- [ ] Unit tests need no Daytona service.
- [ ] The real local integration flow remains explicit and credential-driven.

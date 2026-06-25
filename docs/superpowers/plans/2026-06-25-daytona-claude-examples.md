# Daytona Claude Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three runnable Daytona/Claude Harness examples that demonstrate feedback retry, CLI/test-gated implementation, and configured task-series orchestration.

**Architecture:** Examples live under `examples/` and use protected contracts plus narrow candidate roots. Baselines are allowed to be product-red, but they must be runtime-ready so Harness preflight can create the Agent instead of blocking on setup errors. A repository test validates contracts, sandbox policy boundaries, task selection, and README run instructions without requiring Daytona credentials.

**Tech Stack:** TypeScript `node:test` for repository validation, Harness contract/config loaders, Node.js built-ins for example projects, Daytona/Claude at runtime through `node dist/src/cli.js run --driver claude`.

---

### Task 1: Add Example Validation Test First

**Files:**
- Create: `test/daytona-examples.test.ts`

- [ ] **Step 1: Write failing tests for the intended examples**

Create `test/daytona-examples.test.ts` with this content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadContracts, verifyFrozen } from "../src/contracts.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import {
  loadTaskSeriesConfig,
  selectTaskContracts,
} from "../src/harness/series.js";

const exampleRoot = (name: string) => join(process.cwd(), "examples", name);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadExample(name: string) {
  const root = exampleRoot(name);
  const config = readJson(join(root, "harness.config.json"));
  const { contracts, issues } = loadContracts(join(root, "contracts"));
  return { root, config, contracts, issues };
}

function assertDaytonaReadme(name: string, commandPattern: RegExp): void {
  const readme = readText(join(exampleRoot(name), "README.md"));
  for (const envName of [
    "DAYTONA_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
  ]) {
    assert.match(readme, new RegExp(envName), `${name} documents ${envName}`);
  }
  assert.match(readme, /npm run build/, `${name} builds the source checkout CLI`);
  assert.match(readme, /node dist\/src\/cli\.js run/, `${name} uses source checkout CLI`);
  assert.match(readme, /--driver claude/, `${name} uses the Claude driver`);
  assert.match(readme, commandPattern, `${name} documents its exact run command`);
  assert.match(readme, /Agent sandbox/, `${name} explains the Agent sandbox`);
  assert.match(readme, /Gate sandbox/, `${name} explains the Gate sandbox`);
  assert.match(readme, /\.harness\/runs/, `${name} explains run records`);
}

test("Daytona Claude examples validate contracts and README run instructions", () => {
  for (const name of [
    "resume-health-port",
    "daytona-cli-tdd",
    "daytona-task-series",
  ]) {
    const { contracts, issues } = loadExample(name);
    assert.deepEqual(issues, [], `${name} contracts should parse`);
    for (const contract of contracts) {
      const frozen = verifyFrozen(contract);
      assert.equal(frozen.ok, true, frozen.message);
    }
  }

  assertDaytonaReadme(
    "resume-health-port",
    /--dir examples\/resume-health-port\/contracts --config examples\/resume-health-port\/harness\.config\.json/,
  );
  assertDaytonaReadme(
    "daytona-cli-tdd",
    /--dir examples\/daytona-cli-tdd\/contracts --config examples\/daytona-cli-tdd\/harness\.config\.json/,
  );
  assertDaytonaReadme(
    "daytona-task-series",
    /--driver claude --dir examples\/daytona-task-series\/contracts --config examples\/daytona-task-series\/harness\.config\.json/,
  );
});

test("Daytona Claude examples keep agent mutation scope narrow", () => {
  const cases = [
    {
      name: "resume-health-port",
      candidateRoots: ["examples/resume-health-port/src"],
      readOnlyPaths: [
        "examples/resume-health-port/TASK.md",
        "examples/resume-health-port/package.json",
      ],
      protectedPaths: [
        "examples/resume-health-port/contracts",
        "examples/resume-health-port/harness.config.json",
      ],
    },
    {
      name: "daytona-cli-tdd",
      candidateRoots: ["examples/daytona-cli-tdd/bin"],
      readOnlyPaths: [
        "examples/daytona-cli-tdd/TASK.md",
        "examples/daytona-cli-tdd/package.json",
        "examples/daytona-cli-tdd/test",
      ],
      protectedPaths: [
        "examples/daytona-cli-tdd/contracts",
        "examples/daytona-cli-tdd/harness.config.json",
      ],
    },
    {
      name: "daytona-task-series",
      candidateRoots: ["examples/daytona-task-series/src"],
      readOnlyPaths: [
        "examples/daytona-task-series/TASK.md",
        "examples/daytona-task-series/package.json",
        "examples/daytona-task-series/test",
      ],
      protectedPaths: [
        "examples/daytona-task-series/contracts",
        "examples/daytona-task-series/harness.config.json",
      ],
    },
  ];

  for (const item of cases) {
    const { config } = loadExample(item.name);
    const policy = loadSandboxPolicy(config);
    assert.deepEqual(policy.candidateRoots, item.candidateRoots);
    assert.deepEqual(policy.readOnlyPaths, item.readOnlyPaths);
    for (const protectedPath of item.protectedPaths) {
      assert.ok(
        policy.protectedPaths.includes(protectedPath),
        `${item.name} protects ${protectedPath}`,
      );
    }
  }
});

test("Daytona task series selects task-specific contracts", () => {
  const { config, contracts } = loadExample("daytona-task-series");
  const series = loadTaskSeriesConfig(config)!;
  assert.equal(series.seriesId, "daytona-order-series");
  assert.equal(series.tasks.length, 2);
  assert.equal(series.autoCommit.enabled, false);

  const first = selectTaskContracts({
    contracts,
    task: series.tasks[0]!,
    defaults: series.taskDefaults,
  }).map((contract) => contract.id);
  const second = selectTaskContracts({
    contracts,
    task: series.tasks[1]!,
    defaults: series.taskDefaults,
  }).map((contract) => contract.id);

  assert.deepEqual(first, ["domain.model"]);
  assert.deepEqual(second, ["domain.model", "order.service"]);
});

test("Daytona example files referenced by contracts exist", () => {
  const requiredPaths = [
    "examples/resume-health-port/src/server.js",
    "examples/daytona-cli-tdd/bin/quote.js",
    "examples/daytona-cli-tdd/test/quote-cli.test.js",
    "examples/daytona-task-series/src/domain-model.js",
    "examples/daytona-task-series/src/order-service.js",
    "examples/daytona-task-series/test/domain-model.test.js",
    "examples/daytona-task-series/test/order-service.test.js",
  ];

  for (const path of requiredPaths) {
    assert.equal(existsSync(join(process.cwd(), path)), true, path);
  }
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
npm run build
node --test dist/test/daytona-examples.test.js
```

Expected: fail because `examples/daytona-cli-tdd`, `examples/daytona-task-series`, and the health baseline server do not exist yet.

### Task 2: Normalize Feedback Retry HTTP Example

**Files:**
- Modify: `examples/resume-health-port/README.md`
- Modify: `examples/resume-health-port/TASK.md`
- Modify: `examples/resume-health-port/harness.config.json`
- Create: `examples/resume-health-port/src/server.js`

- [ ] **Step 1: Add a runtime-ready product-red baseline server**

Create `examples/resume-health-port/src/server.js`:

```js
import http from "node:http";

const host = "127.0.0.1";
const port = 3320;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: false, source: "baseline" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`resume health example listening on http://${host}:${port}`);
});
```

- [ ] **Step 2: Update config boundaries**

Set `examples/resume-health-port/harness.config.json` so `candidateRoots` is only `examples/resume-health-port/src`, `readOnlyPaths` includes `TASK.md` and `package.json`, and protected paths include contracts/config/.harness. Keep `gateSetup` starting `node examples/resume-health-port/src/server.js`.

- [ ] **Step 3: Update the task to preserve the intentional retry**

Revise `TASK.md` so Claude is told the business request asks for `ready: true` and port `3321`, but also says Harness gate feedback is authoritative if it reports a different port. This preserves the expected first-attempt mismatch while allowing the second attempt to fix the protected contract.

- [ ] **Step 4: Rewrite README as a full Daytona/Claude runbook**

Document required env vars, source checkout build, exact command:

```bash
npm run build
node dist/src/cli.js run "Read examples/resume-health-port/TASK.md and implement it. Treat Harness gate feedback as authoritative if it conflicts with the task text." \
  --driver claude \
  --dir examples/resume-health-port/contracts \
  --config examples/resume-health-port/harness.config.json \
  --max-attempts 3
```

Also document expected outcome, Agent/Gate sandbox split, run record inspection, and why baseline preflight is product-red rather than readiness-red.

### Task 3: Add CLI Test-Driven Example

**Files:**
- Create: `examples/daytona-cli-tdd/README.md`
- Create: `examples/daytona-cli-tdd/TASK.md`
- Create: `examples/daytona-cli-tdd/harness.config.json`
- Create: `examples/daytona-cli-tdd/package.json`
- Create: `examples/daytona-cli-tdd/bin/quote.js`
- Create: `examples/daytona-cli-tdd/test/quote-cli.test.js`
- Create: `examples/daytona-cli-tdd/contracts/cli.behavior.yaml`

- [ ] **Step 1: Create baseline CLI package**

Create `package.json` with `type: "module"` and script `"test": "node --test test/*.test.js"`. Create `bin/quote.js` that exits with code 1 and prints `quote CLI is not implemented yet`.

- [ ] **Step 2: Create protected tests**

Create `test/quote-cli.test.js` that spawns `node bin/quote.js` and asserts:

- `--text "hello world"` prints `"hello world"` and exits 0.
- `--text "needs spaces" --upper` prints `"NEEDS SPACES"` and exits 0.
- missing `--text` exits 2 and prints usage to stderr.

- [ ] **Step 3: Create command contract**

Create `contracts/cli.behavior.yaml`:

```yaml
id: cli.behavior
type: command
scenario: Quote CLI must satisfy protected executable behavior tests.
cmd: bash
args: ["-lc", "cd examples/daytona-cli-tdd && npm test"]
expectExit: 0
timeoutMs: 120000
```

- [ ] **Step 4: Create Harness config**

Use candidate root `examples/daytona-cli-tdd/bin`, read-only `TASK.md`, `package.json`, and `test`, protected `contracts`, `harness.config.json`, and `.harness`, with baseline `["cli.behavior"]` and no setup commands.

- [ ] **Step 5: Create task and README**

The task tells Claude to implement only `bin/quote.js` according to protected tests. README documents env vars and exact command:

```bash
npm run build
node dist/src/cli.js run "Read examples/daytona-cli-tdd/TASK.md and implement the CLI behavior." \
  --driver claude \
  --dir examples/daytona-cli-tdd/contracts \
  --config examples/daytona-cli-tdd/harness.config.json \
  --max-attempts 3
```

### Task 4: Add Daytona Task-Series Example

**Files:**
- Create: `examples/daytona-task-series/README.md`
- Create: `examples/daytona-task-series/TASK.md`
- Create: `examples/daytona-task-series/harness.config.json`
- Create: `examples/daytona-task-series/package.json`
- Create: `examples/daytona-task-series/src/domain-model.js`
- Create: `examples/daytona-task-series/src/order-service.js`
- Create: `examples/daytona-task-series/test/domain-model.test.js`
- Create: `examples/daytona-task-series/test/order-service.test.js`
- Create: `examples/daytona-task-series/contracts/domain.model.yaml`
- Create: `examples/daytona-task-series/contracts/order.service.yaml`

- [ ] **Step 1: Create baseline stubs**

Create `src/domain-model.js` exporting `createOrder()` that throws `new Error("domain model not implemented")`. Create `src/order-service.js` exporting `createOrderService()` that throws `new Error("order service not implemented")`.

- [ ] **Step 2: Create protected tests**

`test/domain-model.test.js` imports `createOrder` and asserts it returns `{ id, status: "created", totalCents }`, rejects blank ids, and rejects negative totals. `test/order-service.test.js` imports `createOrderService` and asserts it creates orders through the domain model and can mark an order paid.

- [ ] **Step 3: Create task-specific contracts**

`domain.model.yaml` runs `cd examples/daytona-task-series && node --test test/domain-model.test.js`.
`order.service.yaml` runs `cd examples/daytona-task-series && node --test test/order-service.test.js`.

- [ ] **Step 4: Create task-series config**

Use `series.id = "daytona-order-series"`, `autoCommit.enabled = false`, candidate root `examples/daytona-task-series/src`, read-only `TASK.md`, `package.json`, and `test`, protected contracts/config/.harness. Define two tasks:

- `define-domain-model` with contract `domain.model`.
- `implement-order-service` with contracts `domain.model` and `order.service`.

- [ ] **Step 5: Create README**

Document exact series command:

```bash
npm run build
node dist/src/cli.js run \
  --driver claude \
  --dir examples/daytona-task-series/contracts \
  --config examples/daytona-task-series/harness.config.json \
  --max-attempts 3
```

Explain parent/child run records, `.harness/series/daytona-order-series.json`, resume behavior, and `autoCommit.enabled: false`.

### Task 5: Validate And Finish

**Files:**
- Modify if needed: files created in Tasks 1-4

- [ ] **Step 1: Run targeted example validation**

Run:

```bash
npm run build
node --test dist/test/daytona-examples.test.js
```

Expected: pass.

- [ ] **Step 2: Run local contract validation commands**

Run:

```bash
node dist/src/cli.js contract validate examples/resume-health-port/contracts
node dist/src/cli.js contract validate examples/daytona-cli-tdd/contracts
node dist/src/cli.js contract validate examples/daytona-task-series/contracts
```

Expected: all print `✓ 所有契约规格校验通过`.

- [ ] **Step 3: Run full repository check**

Run:

```bash
npm run check
```

Expected: all tests pass.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: only the spec, plan, tests, and example files from this worktree are changed.

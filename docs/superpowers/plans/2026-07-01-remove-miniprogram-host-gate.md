# Remove MiniProgram Host Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the built-in WeChat mini-program host-local gate, make old `type: miniprogram` contracts fail validation explicitly, and remove current guidance that creates the removed gate type.

**Architecture:** Treat `miniprogram` as a removed contract type at validation time, not as a runtime plugin. Delete the mini-program plugin, the host-local execution path that only existed for it, DevTools preflight readiness, templates, fixtures, and toolchain dependency. Keep ordinary remote Gate execution and review semantics intact.

**Tech Stack:** TypeScript, Node.js `node:test`, Harness GateCore plugin system, Markdown docs, npm lockfile.

---

## File Map

- `src/contracts.ts`: owns contract validation. Add a removed-type error for `miniprogram`.
- `test/loader-selector.test.ts`: verifies removed-type validation.
- `src/cli.ts`: remove `miniprogramPlugin` import/registration and host-local preflight split.
- `src/index.ts`: remove `miniprogramPlugin` and host-local helper exports.
- `src/harness/preflight.ts`: remove mini-program command-modeling lint and host-local readiness doctor.
- `src/harness/sandbox/environment.ts`: remove host-local gate split/materialization during Daytona runs.
- `src/harness/host-gate.ts`: delete if unused after removing the only host-local type.
- `src/plugins/miniprogram.ts`: delete.
- `package.json`, `package-lock.json`: remove `miniprogram-automator`.
- `README.md`, `docs/usage.md`, `docs/architecture/*.md`, `src/harness/scaffold.ts`: remove current feature guidance.
- `plugins/harness-prep/skills/harness-prep/**`: remove mini-program preparation guidance and references.
- `examples/miniprogram/`, `test/fixtures/mp-project/`, `test/fixtures/miniprogram-runner.js`: delete removed feature examples and fixtures.
- Tests under `test/`: remove or rewrite miniprogram-specific assertions while preserving remote-gate and publication coverage.

## Task 1: Removed Contract Type Validation

**Files:**
- Modify: `src/contracts.ts`
- Modify: `test/loader-selector.test.ts`

- [ ] **Step 1: Replace the existing miniprogram loader test with removed-type validation**

In `test/loader-selector.test.ts`, replace `loader: miniprogram 缺 projectPath 或 runner → issue` with:

```ts
test("loader: miniprogram is an explicitly removed contract type", () => {
  const issues = validateContract({
    id: "mp.removed",
    type: "miniprogram",
    projectPath: "dist/dev/mp-weixin",
    runner: "test/gates/miniprogram-runner.js",
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.contractId, "mp.removed");
  assert.match(
    issues[0]?.message ?? "",
    /type="miniprogram" has been removed from Harness/,
  );
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
npm run build && node --test dist/test/loader-selector.test.js
```

Expected: fail because `validateContract()` currently accepts a complete `miniprogram` contract.

- [ ] **Step 3: Add removed-type validation**

In `src/contracts.ts`, add:

```ts
const REMOVED_TYPE_MESSAGES: Record<string, string> = {
  miniprogram:
    'type="miniprogram" has been removed from Harness. Use an external CI check, ' +
    'type="command" for remote-executable checks, or type="review" for manual approval.',
};
```

Then in `validateContract()` immediately after resolving `type` and before `REQUIRED_BY_TYPE` lookup:

```ts
const removedMessage = REMOVED_TYPE_MESSAGES[type];
if (removedMessage) {
  issues.push({ file, contractId: id, message: removedMessage });
  return issues;
}
```

Remove `miniprogram: ["projectPath", "runner"],` from `REQUIRED_BY_TYPE`.

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
npm run build && node --test dist/test/loader-selector.test.js
```

Expected: pass.

## Task 2: Remove Plugin Registration And Public API

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Delete: `src/plugins/miniprogram.ts`
- Delete or rewrite: `test/miniprogram-cli.test.ts`
- Delete or rewrite: `test/miniprogram-plugin.test.ts`
- Modify: `test/gate.test.ts` if a plugin list assertion is needed

- [ ] **Step 1: Add/adjust a test proving built-in registration excludes miniprogram**

If no direct test exists, add this to `test/gate.test.ts`:

```ts
import { httpPlugin } from "../src/plugins/http.js";
import { structurePlugin } from "../src/plugins/structure.js";
import { createInvariantPlugin } from "../src/plugins/invariant.js";

test("built-in plugin set excludes removed miniprogram type", () => {
  const gate = new GateCore()
    .use(commandPlugin)
    .use(bootPlugin)
    .use(reviewPlugin)
    .use(httpPlugin)
    .use(structurePlugin)
    .use(createInvariantPlugin({}));

  assert.deepEqual(gate.plugins().sort(), [
    "boot",
    "command",
    "http",
    "invariant",
    "review",
    "structure",
  ]);
});
```

- [ ] **Step 2: Run the targeted test and verify current code still exposes the old plugin elsewhere**

Run:

```bash
npm run build && node --test dist/test/gate.test.js dist/test/miniprogram-cli.test.js dist/test/miniprogram-plugin.test.js
```

Expected: miniprogram tests still pass or compile, proving the old runtime is still present and must be removed.

- [ ] **Step 3: Remove plugin registration and exports**

In `src/cli.ts`, delete:

```ts
import { miniprogramPlugin } from "./plugins/miniprogram.js";
```

and remove `.use(miniprogramPlugin)` from `buildGate()`.

In `src/index.ts`, delete:

```ts
export { miniprogramPlugin } from "./plugins/miniprogram.js";
```

Delete `src/plugins/miniprogram.ts`.

Delete `test/miniprogram-cli.test.ts` and `test/miniprogram-plugin.test.ts`; their behavior belongs to the removed feature.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm run build && node --test dist/test/gate.test.js dist/test/cli-entrypoint.test.js
```

Expected: pass.

## Task 3: Remove Host-Local Run And Preflight Paths

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `src/harness/preflight.ts`
- Modify: `src/cli.ts`
- Delete: `src/harness/host-gate.ts`
- Modify or delete: `test/host-gate.test.ts`
- Modify: `test/daytona-environment.test.ts`
- Modify: `test/preflight-runtime.test.ts`
- Modify: `test/preflight-render.test.ts`
- Modify: `test/remote-gate.test.ts`

- [ ] **Step 1: Rewrite tests away from host-local miniprogram behavior**

Remove tests whose only purpose is miniprogram host-local execution:

```text
test/host-gate.test.ts
test/daytona-environment.test.ts tests named:
  Daytona gate runs miniprogram contracts on host materialized candidate
  Daytona run skips remote gate sandbox when only host-local contracts are selected
  miniprogram gate failure feeds diagnostics back to the Daytona agent
  repeated miniprogram gate failure escalates to human_review_contract
test/preflight-runtime.test.ts tests named:
  host-local miniprogram preflight reports outside Gate coverage
  host-local miniprogram preflight warms and verifies DevTools before agent work
  host-local miniprogram preflight blocks when DevTools readiness fails
```

Keep remote-only Daytona publication and preflight tests intact.

Update `test/preflight-render.test.ts` expected pretty text so it no longer expects host-local informational output.

- [ ] **Step 2: Run affected tests and verify failures point to production imports**

Run:

```bash
npm run build && node --test dist/test/preflight-runtime.test.js dist/test/preflight-render.test.js dist/test/daytona-environment.test.js dist/test/remote-gate.test.js
```

Expected: fail until production imports and host-local branches are removed.

- [ ] **Step 3: Remove host-local execution from Daytona environment**

In `src/harness/sandbox/environment.ts`, delete the import:

```ts
import {
  isHostLocalContract,
  runHostLocalGate,
} from "../host-gate.js";
```

Replace the gate execution split:

```ts
const hostContracts = contracts.filter(isHostLocalContract);
const remoteContracts = contracts.filter((contract) =>
  !isHostLocalContract(contract)
);
const combinedResults: CheckResult[] = [];
```

with:

```ts
const remoteContracts = contracts;
```

Delete the `combinedResults` array and the `runHostLocalGate()` block. After remote gate execution, return `report` directly after cleanup checks. Preserve `aggregate` only if still used elsewhere in the file; otherwise remove the import.

- [ ] **Step 4: Remove host-local preflight from `src/harness/preflight.ts`**

Delete:

```ts
import { checkMiniProgramHostReadiness } from "../plugins/miniprogram.js";
import { isHostLocalContract } from "./host-gate.js";
```

Delete `MINI_PROGRAM_COMMAND_TEXT`, `commandContractMiniProgramSignals()`, `lintCommandContractModeling()`, and `runHostLocalPreflight()`.

In `runGatePreflight()`, use:

```ts
const staticFindings = lintGateReadiness({
  contracts: options.contracts,
  policy: options.policy,
  baseUrl,
});
const selectedContracts = options.contracts.map((contract) => contract.id);
const remoteContracts = options.contracts;
const hostLocalContracts: Contract[] = [];
```

Remove the host-local readiness branch. Keep `hostLocalContracts` in the returned report as `[]`.

In `renderGatePreflightPretty()`, remove the block that appends host-local informational text.

- [ ] **Step 5: Remove static host-local report split from `src/cli.ts`**

Delete:

```ts
import { isHostLocalContract } from "./harness/host-gate.js";
```

In `staticGatePreflightReport()`, set:

```ts
const remoteContracts = contracts;
const hostLocalContracts: Contract[] = [];
```

- [ ] **Step 6: Delete `src/harness/host-gate.ts` and `test/host-gate.test.ts`**

Run:

```bash
rg -n "host-gate|runHostLocalGate|isHostLocalContract|HostLocalGateOptions|materializeCandidateWorkspace" src test
```

Expected: no production or active test references.

- [ ] **Step 7: Run affected tests**

Run:

```bash
npm run build && node --test dist/test/preflight-runtime.test.js dist/test/preflight-render.test.js dist/test/daytona-environment.test.js dist/test/remote-gate.test.js
```

Expected: pass.

## Task 4: Remove Dependency, Examples, Fixtures, And Documentation Guidance

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `examples/miniprogram/`
- Delete: `test/fixtures/mp-project/`
- Delete: `test/fixtures/miniprogram-runner.js`
- Delete or rewrite: `test/miniprogram-templates.test.ts`
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `docs/architecture/gate-plugin-guide.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`
- Modify: `src/harness/scaffold.ts`
- Modify: `plugins/harness-prep/skills/harness-prep/SKILL.md`
- Modify/delete: `plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/source-evidence.md`

- [ ] **Step 1: Remove npm dependency**

Run:

```bash
npm uninstall miniprogram-automator
```

Expected: `package.json` and `package-lock.json` no longer include `miniprogram-automator`.

- [ ] **Step 2: Delete examples and fixtures**

Delete:

```text
examples/miniprogram/
test/fixtures/mp-project/
test/fixtures/miniprogram-runner.js
test/miniprogram-templates.test.ts
```

- [ ] **Step 3: Rewrite docs and skill references**

Remove current feature guidance from:

```text
README.md
docs/usage.md
docs/architecture/gate-plugin-guide.md
docs/architecture/daytona-sandbox-gate.md
src/harness/scaffold.ts
plugins/harness-prep/skills/harness-prep/SKILL.md
plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
plugins/harness-prep/skills/harness-prep/references/gate-translation.md
plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md
plugins/harness-prep/skills/harness-prep/references/source-evidence.md
```

Delete `plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md` unless another reference still needs a historical migration note. If keeping a note, make it explicit that Harness no longer supports the contract type.

- [ ] **Step 4: Search for live mini-program guidance**

Run:

```bash
rg -n "miniprogram|mini-program|MiniProgram|WeChat DevTools|微信开发者工具|小程序|HARNESS_MINIPROGRAM|miniprogram-automator" src test README.md docs plugins examples package.json package-lock.json
```

Expected: remaining hits only in `docs/archive/` and historical `docs/superpowers/specs/` or `docs/superpowers/plans/` files, plus the new removed-type validation message if it contains `miniprogram`.

## Task 5: Full Verification And Cleanup

**Files:**
- All files touched by Tasks 1-4

- [ ] **Step 1: Build and run targeted tests**

Run:

```bash
npm run build
node --test dist/test/loader-selector.test.js dist/test/gate.test.js dist/test/cli-entrypoint.test.js
node --test dist/test/preflight-runtime.test.js dist/test/preflight-render.test.js dist/test/daytona-environment.test.js dist/test/remote-gate.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run the full local suite**

Run:

```bash
npm run check
```

Expected: TypeScript build succeeds and all `dist/test/**/*.test.js` tests pass.

- [ ] **Step 3: Verify removal invariants**

Run:

```bash
rg -n "miniprogramPlugin|checkMiniProgramHostReadiness|HARNESS_MINIPROGRAM|runHostLocalGate|isHostLocalContract|miniprogram-automator" src test package.json package-lock.json
```

Expected: no output.

Run:

```bash
rg -n "type: miniprogram|type=\"miniprogram\"|WeChat DevTools|微信开发者工具|小程序门禁" README.md docs/usage.md docs/architecture plugins/harness-prep src/harness/scaffold.ts examples test
```

Expected: no live guidance outside archive/history. If archive/history is included by command scope, classify those hits before completion.

- [ ] **Step 4: Check whitespace and git state**

Run:

```bash
git diff --check
git status --short
```

Expected: no diff whitespace errors. `git status` should show only intended changes and the pre-existing untracked `.DS_Store`.

## Task 6: Commit The Removal

**Files:**
- All intended implementation, test, docs, dependency, and deletion changes

- [ ] **Step 1: Review diff**

Run:

```bash
git diff --stat
git diff -- src test README.md docs plugins package.json package-lock.json
```

Expected: diff matches the spec and plan; no unrelated `.DS_Store` changes are staged.

- [ ] **Step 2: Commit**

Run:

```bash
git add src test README.md docs plugins examples package.json package-lock.json
git status --short
git commit -m "fix: remove miniprogram host gate"
```

Expected: commit succeeds and `.DS_Store` remains untracked.

- [ ] **Step 3: Final completion audit**

Run:

```bash
git log -1 --oneline
git status --short
```

Expected: latest commit is `fix: remove miniprogram host gate`; only unrelated `.DS_Store` may remain untracked.

Confirm every acceptance item in `docs/superpowers/specs/2026-07-01-remove-miniprogram-host-gate-design.md` with fresh command evidence before reporting completion.

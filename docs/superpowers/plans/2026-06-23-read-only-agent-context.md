# Read-Only Agent Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sandbox.readOnlyPaths` so Harness can upload task context to Agent sandboxes without allowing those files to become candidate changes.

**Architecture:** Split the existing path helper usage into visible context files and mutable candidate files. Policy classification becomes protected -> read-only -> candidate -> ignored, and candidate collection rejects any read-only drift before Gate execution.

**Tech Stack:** TypeScript, Node.js `node:test`, Daytona sandbox adapter tests, Harness plugin Markdown references.

---

### Task 1: Policy Model

**Files:**
- Modify: `src/harness/sandbox/types.ts`
- Modify: `src/harness/sandbox/policy.ts`
- Test: `test/sandbox-policy.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that `loadSandboxPolicy({})` returns `readOnlyPaths: ["AGENTS.md", "docs/specs", "docs/plans"]`, that custom `readOnlyPaths` are normalized and copied, that wrong types fail, that `validateCandidatePath()` rejects read-only paths, and that `classifyWorkspacePath()` returns `"read-only"` before `"candidate"`.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --test dist/test/sandbox-policy.test.js`

Expected: TypeScript/test failures because `readOnlyPaths` and `"read-only"` do not exist yet.

- [ ] **Step 3: Implement minimal policy support**

Add `readOnlyPaths: string[]` to `SandboxPolicy`, include it in defaults and known fields, normalize/copy it in `loadSandboxPolicy()`, reject candidate paths covered by read-only roots, and update the fully-covered candidate-root check to consider protected or read-only roots.

- [ ] **Step 4: Verify green**

Run: `npm run build && node --test dist/test/sandbox-policy.test.js`

Expected: sandbox policy tests pass.

### Task 2: Workspace Visibility And Collection

**Files:**
- Modify: `src/harness/sandbox/workspace.ts`
- Test: `test/sandbox-workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Update `agentVisibleFiles` expectations to include read-only files. Add tests that read-only files are excluded from candidate operations, and that modifying, deleting, or adding under a read-only path makes `collectCandidate()` reject.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --test dist/test/sandbox-workspace.test.js`

Expected: failures showing read-only files are hidden or treated as mutable.

- [ ] **Step 3: Implement minimal workspace support**

Add a helper for mutable candidate baseline files. Make `agentVisibleFiles()` include read-only context. Make `deriveCandidateOperations()` compare only mutable candidate files. Make `collectCandidate()` verify read-only remote files match the baseline and reject additions, deletions, metadata drift, byte drift, symlinks, or special files under read-only paths.

- [ ] **Step 4: Verify green**

Run: `npm run build && node --test dist/test/sandbox-workspace.test.js`

Expected: workspace tests pass.

### Task 3: Gate Assembly Uses Mutable Paths Only

**Files:**
- Modify: `src/harness/sandbox/environment.ts`
- Modify: `src/harness/preflight.ts`
- Modify: `src/harness/host-gate.ts`
- Test: `test/daytona-environment.test.ts`
- Test: `test/host-gate.test.ts`
- Test: `test/preflight-runtime.test.ts`

- [ ] **Step 1: Write failing tests**

Add or adjust tests so Gate removal and host-local materialization remove only mutable candidate baseline files, while read-only files remain baseline-controlled.

- [ ] **Step 2: Verify red**

Run: `npm run build && node --test dist/test/daytona-environment.test.js dist/test/host-gate.test.js dist/test/preflight-runtime.test.js`

Expected: failures where read-only files are treated as mutable.

- [ ] **Step 3: Implement call-site changes**

Replace mutable uses of `agentVisibleFiles()` with the new mutable helper. Include `readOnlyPaths` in remote watched roots during candidate collection.

- [ ] **Step 4: Verify green**

Run: `npm run build && node --test dist/test/daytona-environment.test.js dist/test/host-gate.test.js dist/test/preflight-runtime.test.js`

Expected: focused gate tests pass.

### Task 4: Docs And Plugin Guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `docs/architecture/daytona-sandbox-gate.md`
- Modify: `src/harness/scaffold.ts`
- Modify: `examples/harness.config.json`
- Modify: `examples/serial-task-series/harness.config.json`
- Modify: `plugins/harness-prep/skills/harness-prep/SKILL.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/agent-environment.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/reliability-checks.md`
- Modify: `plugins/harness-prep/skills/harness-prep/references/source-evidence.md`

- [ ] **Step 1: Update guidance**

Document `readOnlyPaths` as context-visible/non-publishable. Put `AGENTS.md`, `docs/specs`, and `docs/plans` in scaffolded config examples. Keep contracts, test gates, config, and Harness state protected.

- [ ] **Step 2: Validate plugin**

Run: `python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/harness-prep`

Expected: plugin validation passes.

### Task 5: Final Verification

**Files:**
- All modified source, tests, docs, and plugin references.

- [ ] **Step 1: Run full project check**

Run: `npm run check`

Expected: TypeScript build and full compiled test suite pass.

- [ ] **Step 2: Inspect diff**

Run: `git diff -- src test docs README.md examples plugins/harness-prep`

Expected: diff contains only read-only sandbox support and documentation/plugin guidance updates, with unrelated pre-existing dirty files left intact.

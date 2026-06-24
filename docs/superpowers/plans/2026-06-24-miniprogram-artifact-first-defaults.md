# Mini-program Artifact-first Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness preparation guidance and examples describe mini-program gates as artifact-first by default: the Agent builds, Harness consumes the compiled mini-program artifact, and Gate-side rebuilds are opt-in only.

**Architecture:** This is a guidance and template update, not a new framework integration. The `miniprogram` plugin remains framework-agnostic and continues to consume `projectPath`; docs and tests make it explicit that Harness does not hardcode uni-app/Taro/native build support.

**Tech Stack:** TypeScript `node:test` tests, Markdown reference docs, YAML/JS mini-program gate examples.

---

## File Structure

- Modify `test/miniprogram-templates.test.ts`
  - Add assertions that the harness-prep mini-program reference and examples document artifact-first defaults.
  - Add assertions that Gate-side rebuilds are described as opt-in source reproducibility, not default behavior.
- Modify `plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md`
  - Add an "Artifact-first Default" section.
  - Change validation guidance so local build commands are examples for host manual checks, not the default Gate responsibility.
  - Add an "Opt-in Rebuild Gate" section for strict source reproducibility.
- Modify `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
  - State that mini-program behavior tasks should default to `gateSetup: []`.
  - State that framework-specific build contracts such as uni-app/Taro/native builds are optional command contracts, not Harness plugin support.
- Modify `examples/miniprogram/README.md`
  - Explain that templates assume an already-built mini-program artifact.
  - Explain that the Agent or developer workflow produces the artifact before the gate consumes it.
  - Explain that rebuilding inside Gate is an optional stricter pattern, not the template default.

## Task 1: Add Failing Documentation Assertions

**Files:**
- Modify: `test/miniprogram-templates.test.ts`

- [ ] **Step 1: Add artifact-first assertions**

Add the following assertions to `test("miniprogram prep skill documents host-local runner rules", ...)` after the existing `NODE_PATH` / `createRequire` assertions:

```ts
  assert.match(reference, /Artifact-first Default/);
  assert.match(reference, /Agent sandbox owns dependency installation and framework-specific builds/);
  assert.match(reference, /Gate-side rebuilds are opt-in source reproducibility checks/);
  assert.match(reference, /Do not make npm ci or npm run build the default Gate path/);
  assert.match(reference, /not a uni-app, Taro, or native mini-program build plugin/);
  assert.match(readme, /already-built mini-program artifact/);
  assert.match(readme, /Templates do not rebuild the project inside Gate by default/);
  assert.match(readme, /source reproducibility/);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

Expected: failure in `miniprogram prep skill documents host-local runner rules` because the new phrases are not yet documented.

- [ ] **Step 3: Commit only the red test if committing per-step**

```bash
git add test/miniprogram-templates.test.ts
git commit -m "test: require artifact-first miniprogram guidance"
```

## Task 2: Update Harness Prep Mini-program Reference

**Files:**
- Modify: `plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md`

- [ ] **Step 1: Add artifact-first default section**

Insert after the "Execution Model" section:

```md
## Artifact-first Default

Default mini-program behavior gates should validate an already-built
mini-program artifact. The Agent sandbox owns dependency installation and
framework-specific builds. Harness should consume the compiled `projectPath`
such as `dist/build/mp-weixin`; it is not a uni-app, Taro, or native
mini-program build plugin.

Do not make `npm ci`, package lifecycle scripts, or `npm run build` the default
Gate path for mini-program behavior tasks. Those steps add network, package
manager, Node version, and framework-toolchain failure modes before the
user-visible mini-program behavior is tested.

For a normal task series:

- Tell the Agent to install dependencies and build the mini-program artifact.
- Include the compiled artifact root in `candidateRoots`.
- Keep mini-program behavior gates pointed at the compiled `projectPath`.
- Keep `gateSetup` empty unless another selected remote contract truly needs
  setup.
- Use a lightweight artifact check if you need early feedback that the Agent
  published `project.config.json`, `app.json`, and expected page files.
```

- [ ] **Step 2: Add opt-in rebuild guidance**

Insert before "Validation Workflow":

```md
## Opt-in Rebuild Gate

Gate-side rebuilds are opt-in source reproducibility checks. Use them only when
the requirement is "a fresh remote environment can rebuild this candidate from
source." Name and document that contract separately from the behavior gate.

A rebuild contract can run framework-specific commands such as
`npm run build:mp-weixin`, but that is ordinary `type: command` behavior, not
special mini-program plugin support. If you enable such a gate, make sure
`candidateRoots` contains every manifest, lockfile, build config, and helper
script used by package lifecycle hooks.
```

- [ ] **Step 3: Replace default-ish validation wording**

Replace the sentence "Build first when you want to run the actual host-local UI gate:" with:

```md
For host-local manual checks, build or otherwise materialize the artifact before
running the UI gate:
```

Keep the following command examples because they remain useful for local manual validation.

- [ ] **Step 4: Run the focused test**

Run:

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

Expected: the reference-related new assertions pass, README assertions may still fail until Task 4.

## Task 3: Update Contracts And Config Guidance

**Files:**
- Modify: `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`

- [ ] **Step 1: Extend mini-program rules**

Add these bullets under the existing "Rules:" list in the "MiniProgram Contract" section:

```md
- For mini-program behavior tasks, default to Agent-built artifacts and
  `gateSetup: []`; do not make dependency install or rebuild commands the
  default Gate path.
- Framework-specific rebuilds, including uni-app, Taro, or native mini-program
  build commands, belong in optional `type: command` contracts for source
  reproducibility. They are not part of the `miniprogram` plugin contract.
```

- [ ] **Step 2: Add config rule for artifact-first gates**

Add this bullet near the existing `candidateRoots` mini-program artifact rule:

```md
- For default mini-program behavior gates, let the implementation Agent produce
  the compiled artifact and keep `gateSetup` empty. Add Gate-side install/build
  commands only for explicit source reproducibility requirements.
```

- [ ] **Step 3: Run the focused test**

Run:

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

Expected: no new failures from this doc-only change; any remaining failure should be the README assertions from Task 1.

## Task 4: Update Mini-program Examples README

**Files:**
- Modify: `examples/miniprogram/README.md`

- [ ] **Step 1: Add artifact-first explanation after artifact path**

After the paragraph "Adjust `projectPath` if your artifact path is different.", add:

```md
The templates assume an already-built mini-program artifact. In a Daytona-backed
Harness run, the Agent or project workflow should produce that artifact and
publish it through `candidateRoots`; the host-local mini-program gate then opens
the materialized artifact in WeChat DevTools.

Templates do not rebuild the project inside Gate by default. If you need source
reproducibility, add a separate `type: command` contract that installs
dependencies and runs the project-specific build, and treat failures from that
contract as rebuild failures rather than mini-program behavior failures.
```

- [ ] **Step 2: Add run guidance sentence**

In the "Run" section before `harness check --dir contracts --json`, add:

```md
Make sure `projectPath` exists before running the behavior gate. Harness does
not infer how to build the artifact from the framework.
```

- [ ] **Step 3: Run the focused test and confirm green**

Run:

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

Expected: `miniprogram-templates.test.js` passes.

- [ ] **Step 4: Run adjacent targeted tests**

Run:

```bash
npm run build && node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-cli.test.js dist/test/miniprogram-templates.test.js
```

Expected: all targeted mini-program tests pass.

## Task 5: Final Verification And Commit

**Files:**
- Verify only.

- [ ] **Step 1: Check working tree**

Run:

```bash
git status --short
```

Expected changed files:

```text
 M examples/miniprogram/README.md
 M plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
 M plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
 M test/miniprogram-templates.test.ts
```

- [ ] **Step 2: Run final targeted verification**

Run:

```bash
npm run build && node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-cli.test.js dist/test/miniprogram-templates.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 3: Commit**

```bash
git add examples/miniprogram/README.md \
  plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md \
  plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md \
  test/miniprogram-templates.test.ts
git commit -m "docs: default miniprogram gates to artifacts"
```

## Self-review

- Spec coverage: This plan implements the approved design by making mini-program gates artifact-first in skill guidance and examples, while leaving framework-specific rebuilds as optional command contracts.
- Scan check: No unfinished markers or undefined implementation steps remain.
- Scope check: No production plugin behavior changes are planned; Harness remains framework-agnostic.

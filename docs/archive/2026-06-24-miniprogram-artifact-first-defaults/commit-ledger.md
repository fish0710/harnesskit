# Commit Ledger

Base branch: `main`

Working branch: `codex/miniprogram-artifact-defaults`

Pre-archive base:

```text
89a73d9 docs: design artifact-first miniprogram gates
```

Implementation commit:

```text
5ff7b44 docs: default miniprogram gates to artifacts
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers making artifact-first behavior the documented default for
mini-program Harness tasks:

- document that Agent/project workflow produces compiled mini-program artifacts;
- document that `miniprogram` gate consumes `projectPath` and remains
  framework-agnostic;
- document `gateSetup: []` as the default behavior gate path;
- classify Gate-side rebuilds as optional source reproducibility command
  contracts;
- update examples so templates assume an already-built artifact;
- add regression assertions to keep the guidance from drifting back to default
  Gate-side build behavior.

## Key Files

```text
docs/superpowers/plans/2026-06-24-miniprogram-artifact-first-defaults.md
examples/miniprogram/README.md
plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
test/miniprogram-templates.test.ts
docs/archive/2026-06-24-miniprogram-artifact-first-defaults/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/miniprogram-templates.test.js
npm run build && node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-cli.test.js dist/test/miniprogram-templates.test.js
```

Observed result:

```text
focused miniprogram template tests: tests 2, pass 2, fail 0
targeted miniprogram tests: tests 58, pass 58, fail 0
```

## Residual Risk

This work updates guidance and tests only. It does not add automatic artifact
existence contracts or change how `miniprogram` contracts execute. Future
Harness prep tasks still need to select or write the appropriate artifact check
when a project benefits from one.

# Commit Ledger

Base branch: `main`

Working branch: `main`

Pre-archive base:

```text
5ff7b44 docs: default miniprogram gates to artifacts
```

Implementation commit: the commit containing this ledger.

Archive commit: same as implementation commit.

## Scope

This archive covers exposing Gate runtime facts to implementation agents and
documenting clean rebuilds as an explicit final source-reproducibility task:

- generate `docs/reference/harness-runtime.md` from `harness create`;
- add `docs/reference` to default read-only sandbox context;
- point scaffolded `AGENTS.md` at the runtime reference;
- update harness-prep skill guidance for read-only runtime context;
- document mini-program clean rebuilds as final series tasks;
- add regression tests for scaffold defaults, sandbox policy defaults, and
  harness-prep guidance.

## Key Files

```text
docs/superpowers/plans/2026-06-24-gate-runtime-clean-build-guidance.md
src/harness/scaffold.ts
src/harness/sandbox/policy.ts
plugins/harness-prep/skills/harness-prep/SKILL.md
plugins/harness-prep/skills/harness-prep/references/agent-environment.md
plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md
test/scaffold.test.ts
test/sandbox-policy.test.ts
test/miniprogram-templates.test.ts
test/daytona-gate-snapshot.test.ts
docs/archive/2026-06-24-gate-runtime-clean-build-guidance/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/scaffold.test.js dist/test/sandbox-policy.test.js dist/test/miniprogram-templates.test.js dist/test/daytona-gate-snapshot.test.js
npm test
git diff --check
```

Observed result:

```text
targeted regression: tests 55, pass 55, fail 0
full suite with elevated loopback permission: tests 579, pass 579, fail 0
git diff --check: no output
```

## Residual Risk

The runtime reference is scaffolded markdown rather than generated from
`toolchain.ts`. Future snapshot changes should update scaffold text,
`sandbox-snapshots.md`, and the corresponding tests together.

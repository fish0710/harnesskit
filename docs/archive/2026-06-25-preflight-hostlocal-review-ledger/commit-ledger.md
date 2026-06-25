# Commit Ledger

Base branch: `main`

Working branch: `fix/preflight-hostlocal-review-ledger`

Pre-archive base:

```text
11d326b chore: refresh harness prep codex plugin
```

Implementation commits:

```text
05c0661 docs: design preflight hostlocal review ledger fixes
ae8a540 docs: plan preflight hostlocal review ledger fixes
5847c30 fix: reject miniprogram command preflight contracts
5f24347 fix: resume blocked review tasks with verdicts
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers two workflow fixes:

- fail fast in Gate preflight when a mini-program automation contract is
  mis-modeled as `type: command`;
- allow a blocked task-series review task to rerun when the selected review
  contract already has a stored verdict and the task hash is unchanged.

## Key Files

```text
docs/superpowers/specs/2026-06-25-preflight-hostlocal-review-ledger-design.md
docs/superpowers/plans/2026-06-25-preflight-hostlocal-review-ledger.md
src/harness/preflight.ts
src/harness/series.ts
test/preflight-runtime.test.ts
test/harness-series.test.ts
docs/archive/2026-06-25-preflight-hostlocal-review-ledger/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/host-gate.test.js dist/test/preflight-runtime.test.js dist/test/preflight-lint.test.js dist/test/harness-series.test.js dist/test/cli-series.test.js
npm run check
git diff --check
```

Observed result:

```text
targeted regression: tests 156, pass 156, fail 0
full suite: tests 582, pass 582, fail 0
git diff --check: no output
```

## Residual Risk

The mini-program command modeling lint intentionally uses strong static signals
instead of broad heuristics. Ambiguous command contracts without those signals
will continue through normal remote Gate handling.

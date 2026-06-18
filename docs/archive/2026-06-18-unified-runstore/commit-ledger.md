# Commit Ledger

Base branch: `main`

Feature branch: `codex/unified-runstore`

Base commit:

```text
4906952 Merge branch 'codex/serial-tasks-auto-commit'
```

Archive commit: the commit containing this ledger.

## Scope

This branch contains the unified RunStore implementation for `harness run`:

- v3 persistent run records;
- single/series/series-task kind separation;
- parent/child run linking;
- setup and validation failure recording;
- CLI run listing/showing;
- legacy v1/v2 compatibility;
- documentation and regression coverage.

## Verification Before Merge

```text
git diff --check
npm run check
```

Expected result:

```text
tests 435
pass 435
fail 0
```

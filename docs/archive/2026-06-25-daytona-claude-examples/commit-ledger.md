# Commit Ledger

Base branch: `main`

Working branch: `feat/daytona-claude-examples`

Pre-archive base:

```text
8193d27 Merge branch 'fix/daytona-claude-stream-command'
```

Implementation commit:

```text
27f1206 feat: add Daytona Claude examples
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers the addition and verification of three real
Daytona/Claude-backed Harness examples:

- feedback/retry HTTP service example;
- CLI TDD command-contract example;
- configured two-task series example.

## Key Files

```text
docs/superpowers/specs/2026-06-25-daytona-claude-examples-design.md
docs/superpowers/plans/2026-06-25-daytona-claude-examples.md
examples/resume-health-port/
examples/daytona-cli-tdd/
examples/daytona-task-series/
test/daytona-examples.test.ts
docs/archive/2026-06-25-daytona-claude-examples/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/daytona-examples.test.js
node dist/src/cli.js contract validate examples/resume-health-port/contracts
node dist/src/cli.js contract validate examples/daytona-cli-tdd/contracts
node dist/src/cli.js contract validate examples/daytona-task-series/contracts
npm run check
git diff --check
```

Observed result:

```text
targeted example validation: tests 4, pass 4, fail 0
contract validation: all three directories passed
full suite: tests 601, pass 601, fail 0
git diff --check: no output
```

Live Daytona/Claude verification:

```text
resume-health-port:
  runId: 2026-06-25T07-22-22-166Z-cef45125
  outcome: ready_for_mr
  summary: pass 1/1

daytona-cli-tdd:
  runId: 2026-06-25T07-39-40-351Z-e1864ae9
  outcome: ready_for_mr
  summary: pass 1/1

daytona-task-series:
  parentRunId: 2026-06-25T07-45-35-843Z-c3804e60
  outcome: completed
  summary: pass 2/2
```

## Residual Risk

The examples are intentionally product-red at baseline so users can observe
Harness solving them. A successful live run publishes candidate files into the
working copy used for that run; use a disposable copy or branch to preserve the
example baseline.

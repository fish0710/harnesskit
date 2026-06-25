# Verification

## Local Baseline In Isolated Worktree

Worktree:

```text
/Users/zhongyy40/workspace/harnesscli/harness/.worktrees/daytona-claude-examples
```

Branch:

```text
feat/daytona-claude-examples
```

Initial baseline before implementation:

```bash
npm ci
npm run check
```

Observed result:

```text
tests 597
pass 597
fail 0
```

## RED

Command:

```bash
npm run build && node --test dist/test/daytona-examples.test.js
```

Observed result before examples existed:

```text
tests 4
pass 0
fail 4
```

Key failures:

```text
ENOENT: examples/daytona-cli-tdd/harness.config.json
candidateRoots mismatch for examples/resume-health-port
ENOENT: examples/daytona-task-series/harness.config.json
examples/resume-health-port/src/server.js false !== true
```

This proved the new drift test actually required the intended example files and
sandbox policy boundaries.

## GREEN

Targeted example validation:

```bash
npm run build && node --test dist/test/daytona-examples.test.js
```

Observed result:

```text
tests 4
pass 4
fail 0
```

Contract validation:

```bash
node dist/src/cli.js contract validate examples/resume-health-port/contracts
node dist/src/cli.js contract validate examples/daytona-cli-tdd/contracts
node dist/src/cli.js contract validate examples/daytona-task-series/contracts
```

Observed result for each:

```text
✓ 所有契约规格校验通过
```

Full suite:

```bash
npm run check
```

Observed final result:

```text
tests 601
pass 601
fail 0
```

Note: one intermediate full-suite run hit a pre-existing timing-sensitive
miniprogram test failure. The same test passed in isolation and the full suite
passed on rerun. No miniprogram files were changed by this work.

## Live Daytona/Claude Verification

Live runs were executed in a disposable copy:

```text
/tmp/harness-daytona-live-resume
```

The command environment was loaded with `zsh -ic` so the user's `.zshrc`
provided the required `DAYTONA_*` and `ANTHROPIC_*` variables. Secret values
were not recorded.

### Feedback Retry HTTP Example

Command:

```bash
node dist/src/cli.js run "Read examples/resume-health-port/TASK.md and implement it. Treat Harness gate feedback as authoritative if it conflicts with the task text." \
  --driver claude \
  --dir examples/resume-health-port/contracts \
  --config examples/resume-health-port/harness.config.json \
  --max-attempts 3 \
  --verbose
```

Run record:

```text
.harness/runs/2026-06-25T07-22-22-166Z-cef45125.json
```

Observed result:

```text
status: completed
outcome: ready_for_mr
selectedContracts: health.port
summary: pass 1/1, fail 0, error 0, review 0
publication: examples/resume-health-port/src/server.js
```

Attempt evidence:

```text
attempt 1 agentSandboxId: eab71bc0-d547-4710-ac35-fde58ba01983
attempt 1 gateSandboxIds: b55a01b4-bab0-4778-8e78-e11ed0d59ca9
attempt 1 claudeSessionId: 2454a7d9-850a-441f-ab04-b5c9f55bfe5c

attempt 2 agentSandboxId: eab71bc0-d547-4710-ac35-fde58ba01983
attempt 2 gateSandboxIds: f1616430-5767-4f05-a905-2a83c5332267
attempt 2 claudeSessionId: 2454a7d9-850a-441f-ab04-b5c9f55bfe5c
attempt 2 resumedFromSessionId: 2454a7d9-850a-441f-ab04-b5c9f55bfe5c
```

Post-run host check with the published server started locally:

```bash
node dist/src/cli.js check --dir examples/resume-health-port/contracts --config examples/resume-health-port/harness.config.json --json
```

Observed result:

```text
outcome: pass
summary: pass 1/1
```

### CLI TDD Example

Command:

```bash
node dist/src/cli.js run "Read examples/daytona-cli-tdd/TASK.md and implement the CLI behavior." \
  --driver claude \
  --dir examples/daytona-cli-tdd/contracts \
  --config examples/daytona-cli-tdd/harness.config.json \
  --max-attempts 3 \
  --verbose
```

Run record:

```text
.harness/runs/2026-06-25T07-39-40-351Z-e1864ae9.json
```

Observed result:

```text
status: completed
outcome: ready_for_mr
selectedContracts: cli.behavior
summary: pass 1/1, fail 0, error 0, review 0
publication: examples/daytona-cli-tdd/bin/quote.js
```

Attempt evidence:

```text
attempt 1 agentSandboxId: b2ab1795-8fb0-4159-9258-2a587b2d64c3
attempt 1 gateSandboxIds: fed97e69-d4bf-454d-98e4-2e739e16889b
attempt 1 claudeSessionId: f2b6f2c6-6ba3-43ec-bc8e-48c7fdd64880
```

Post-run host check:

```bash
node dist/src/cli.js check --dir examples/daytona-cli-tdd/contracts --config examples/daytona-cli-tdd/harness.config.json --json
```

Observed result:

```text
outcome: pass
summary: pass 1/1
```

### Configured Task-Series Example

Command:

```bash
node dist/src/cli.js run \
  --driver claude \
  --dir examples/daytona-task-series/contracts \
  --config examples/daytona-task-series/harness.config.json \
  --max-attempts 3 \
  --verbose
```

Parent run record:

```text
.harness/runs/2026-06-25T07-45-35-843Z-c3804e60.json
```

Observed parent result:

```text
kind: series
status: completed
outcome: completed
summary: pass 2/2, fail 0, error 0, review 0
```

Child run records:

```text
define-domain-model:
  runId: 2026-06-25T07-45-35-910Z-a3475db2
  outcome: ready_for_mr
  selectedContracts: domain.model
  publication: examples/daytona-task-series/src/domain-model.js
  agentSandboxId: 42aee647-c115-446f-8bbc-06bec0c83dd9
  gateSandboxIds: 641c1b60-ca73-452a-9a12-8a0469bef060
  claudeSessionId: 174312cc-6d84-40c3-a061-a12c830a1765

implement-order-service:
  runId: 2026-06-25T07-50-29-747Z-cbf8a195
  outcome: ready_for_mr
  selectedContracts: domain.model, order.service
  publication: examples/daytona-task-series/src/order-service.js
  agentSandboxId: 2e805af5-0f21-4733-911c-615e9e226b25
  gateSandboxIds: a567b126-0bc6-4e3e-8264-4f64a51d48c0
  claudeSessionId: 8e09e039-219c-45ed-b7f9-91fbfa0b48bc
```

Series ledger:

```text
.harness/series/daytona-order-series.json
status: completed
tasks:
  define-domain-model: completed
  implement-order-service: completed
```

Post-run host check:

```bash
node dist/src/cli.js check --dir examples/daytona-task-series/contracts --config examples/daytona-task-series/harness.config.json --json
```

Observed result:

```text
outcome: pass
summary: pass 2/2
```

## Diff Hygiene

Command:

```bash
git diff --check
```

Observed result:

```text
no output
```

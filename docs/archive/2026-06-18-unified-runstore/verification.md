# Verification

## Full Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 435
pass 435
fail 0
```

## Diff Whitespace Check

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

## Targeted RunStore Regression Suite

命令：

```bash
npm run build
node --test \
  dist/test/run-store.test.js \
  dist/test/cli-run-record.test.js \
  dist/test/cli-series.test.js \
  dist/test/observability.test.js \
  dist/test/frozen-contract-callers.test.js \
  dist/test/harness-run.test.js \
  dist/test/harness-series.test.js
```

结果：

```text
tests 110
pass 110
fail 0
```

## Real Scaffold Series Example

临时仓库：

```text
/tmp/harness-runstore-example-iYExOt
```

命令：

```bash
node dist/src/cli.js run --driver scaffold --dir contracts
```

结果：

```text
harness series · id=demo-series · tasks=2
[1/2] pass-task
[2/2] blocked-task
series stopped at blocked-task: blocked
exit status 2
```

生成 run records：

```text
.harness/runs/2026-06-18T02-07-21-301Z-ddcb5efc.json  # series parent
.harness/runs/2026-06-18T02-07-21-976Z-6e8d2fdb.json  # pass child
.harness/runs/2026-06-18T02-07-22-638Z-f5400827.json  # blocked child
```

关键 parent record：

```json
{
  "kind": "series",
  "status": "completed",
  "outcome": "blocked",
  "summary": {
    "total": 2,
    "pass": 1,
    "fail": 0,
    "error": 0,
    "needsReview": 1
  },
  "children": [
    {
      "taskId": "pass-task",
      "status": "completed",
      "outcome": "ready_for_mr"
    },
    {
      "taskId": "blocked-task",
      "status": "completed",
      "outcome": "blocked"
    }
  ]
}
```

## Reviewer Feedback

Reviewer subagents were used during implementation. Important feedback fixed before archive:

- parent record now contains child references;
- task selector failures now create `series-task` error records;
- v3 validation is kind-aware;
- failed publication details are preserved;
- positive v2 compatibility test uses a handcrafted v2 fixture.

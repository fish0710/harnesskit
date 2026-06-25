# Verification

## RED

### Mini-Program Command Preflight

命令：

```bash
npm run build && node --test dist/test/preflight-runtime.test.js --test-name-pattern "mini-program command contracts fail preflight"
```

结果：

```text
tests 16
pass 15
fail 1
```

关键失败：

```text
mini-program command contracts fail preflight before sandbox creation
Expected values to be strictly equal:
+ actual - expected
+ 'ready'
- 'not_ready'
```

该失败证明旧实现会把含 `projectPath`、`runner`、`devtools` 的 command 合同继续当作
远端 Gate 合同执行。

### Blocked Review Resume Decision

命令：

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "decideTaskResume stops terminal non-success states"
```

结果：

```text
test/harness-series.test.ts: Object literal may only specify known properties,
and 'hasResolvedReviewVerdict' does not exist
```

该失败证明 resume decision 还没有表达“review verdict 已存在，可安全重跑”的输入。

### Blocked Review Series Resume

命令：

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "runTaskSeries .*blocked review"
```

结果：

```text
tests 51
pass 50
fail 1
```

关键失败：

```text
runTaskSeries reruns blocked review task when a matching verdict exists
actual: { outcome: 'error', taskId: 'review-task',
  reason: 'task review-task 已处于 blocked 状态，需人工处理后再继续' }
expected: { outcome: 'completed' }
```

该失败复现了 `.harness/verdicts.json` 已有 verdict 时 series 仍被 ledger blocked
状态挡住的问题。

## GREEN

### Mini-Program Command Preflight

命令：

```bash
npm run build && node --test dist/test/preflight-runtime.test.js --test-name-pattern "mini-program command contracts fail preflight"
```

结果：

```text
tests 16
pass 16
fail 0
```

### Blocked Review Resume Decision

命令：

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "decideTaskResume stops terminal non-success states"
```

结果：

```text
tests 49
pass 49
fail 0
```

### Blocked Review Series Resume

命令：

```bash
npm run build && node --test dist/test/harness-series.test.js --test-name-pattern "blocked review"
```

结果：

```text
tests 51
pass 51
fail 0
```

## Targeted Regression Coverage

命令：

```bash
npm run build && node --test dist/test/host-gate.test.js dist/test/preflight-runtime.test.js dist/test/preflight-lint.test.js dist/test/harness-series.test.js dist/test/cli-series.test.js
```

结果：

```text
tests 156
pass 156
fail 0
```

覆盖重点：

- `isHostLocalContract()` 仍只识别 `type: miniprogram`；
- mis-modeled mini-program command 在 preflight 静态阶段被阻断；
- 普通 preflight lint、host-local gate 和 loopback HTTP 行为未回退；
- blocked review task 有 matching verdict 时会重跑；
- blocked review task 无 verdict 时仍停止；
- CLI series 记录行为未回退。

## Full Suite

命令：

```bash
npm run check
```

结果：

```text
tests 582
pass 582
fail 0
```

## Diff Hygiene

命令：

```bash
git diff --check
```

结果：无输出，表示没有 whitespace 错误。

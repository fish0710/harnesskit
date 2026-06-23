# Verification

## Targeted Regression Suite

命令：

```bash
npm run build && node --test dist/test/diagnostic-log.test.js dist/test/cli-redaction.test.js dist/test/run-store.test.js dist/test/harness-run.test.js dist/test/cli-run-record.test.js
```

结果：

```text
tests 25
pass 25
fail 0
exit 0
```

覆盖重点：

- disabled logger 不输出、不创建 JSONL；
- enabled logger 实时输出并写 JSONL；
- secret-like 字段递归 redaction；
- RunStore 持久化并读取 `diagnosticLogPath`；
- run loop 发出 attempt/agent/gate/publish/close 诊断事件；
- CLI `--verbose` 创建 JSONL 并写入 run record；
- 非 verbose run 不写 `diagnosticLogPath`；
- setup failure 仍写 error 级别诊断 entry。

## Full Check

命令：

```bash
npm run check
```

结果：

```text
build exit 0
tests 575
pass 575
fail 0
exit 0
```

## Additional Focused Check

`npm run check` 初次运行时暴露出既有 bin symlink 入口测试失败：

```text
CLI runs when invoked through a bin symlink
status null !== 0
```

根因是 `tsc` 生成的 `dist/src/cli.js` 为 `0644`，通过 package bin symlink 直接
执行时会因为缺少 executable bit 失败。修复后单独验证：

```bash
npm run build && node --test dist/test/cli-entrypoint.test.js
```

结果：

```text
tests 1
pass 1
fail 0
exit 0
```

随后再次执行 `npm run check`，全量通过。

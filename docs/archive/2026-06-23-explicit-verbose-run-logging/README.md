# Explicit Verbose Run Logging Archive

归档日期：2026-06-23

当前分支：`feat/explicit-verbose-run-logging`

合入目标：`main`

## 背景

Harness run 在真实执行中只有少量摘要输出。Agent、Gate readiness、Daytona
sandbox observation、run loop retry/escalation 等关键步骤虽然部分写入 RunStore
events，但调试时很难实时判断当前卡在哪一步，也不方便把一次 run 的诊断完整交给
后续排查。

本轮实现显式详细日志模式，避免默认输出刷屏，同时让需要调试的人可以实时 tail 和
事后审计同一份结构化日志。

## 最终机制

- `harness run` 和 `harness fix` 支持 `--verbose`。
- 脚本和 CI 可以用 `HARNESS_VERBOSE=1` 开启同一模式。
- verbose 开启后，CLI 会实时打印结构化诊断行，并写入：

```text
.harness/runs/<runId>.log.jsonl
```

- run record 增加 `diagnosticLogPath`，指向对应 JSONL 文件。
- 非 verbose run 保持原有紧凑输出，不写 `diagnosticLogPath`。
- 诊断日志覆盖：
  - `run.setup`：run record、agent、contracts、gate、policy、budget；
  - `preflight`：Gate readiness start/end/blocker；
  - `sandbox`：Daytona observation events；
  - `loop`：attempt、agent、gate、publish、retry/escalation、close；
  - `series`：series start/skip/task start/setup error/stop/completion。
- redaction 逻辑从 `src/cli.ts` 抽到共享模块，终端和 JSONL 都会遮蔽
  key/token/secret/password/auth/cookie 等字段。
- `npm run build` 现在会把 package bin 指向的 `dist/src/cli.js` 和
  `dist/demo/run-demo.js` 标为 executable，修复 bin symlink 入口测试。

## 交付物

| 产出 | 路径 |
|---|---|
| Diagnostic logger | [diagnostic-log.ts](../../../src/harness/diagnostic-log.ts) |
| Shared redaction | [redaction.ts](../../../src/harness/redaction.ts) |
| RunStore diagnostic path | [record.ts](../../../src/harness/record.ts) |
| Run loop diagnostics | [run.ts](../../../src/harness/run.ts) |
| CLI verbose wiring | [cli.ts](../../../src/cli.ts) |
| Build executable bin fix | [package.json](../../../package.json) |
| Logger tests | [diagnostic-log.test.ts](../../../test/diagnostic-log.test.ts) |
| RunStore tests | [run-store.test.ts](../../../test/run-store.test.ts) |
| Run loop tests | [harness-run.test.ts](../../../test/harness-run.test.ts) |
| CLI run record tests | [cli-run-record.test.ts](../../../test/cli-run-record.test.ts) |
| Usage docs | [usage.md](../../../docs/usage.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 使用方式

```bash
harness run "实现任务" --driver claude --verbose
HARNESS_VERBOSE=1 harness fix --driver claude
```

完成后查看 run record：

```bash
harness runs show <runId> --json
```

其中 `diagnosticLogPath` 指向同一次 run 的 JSONL 诊断文件。

## 归档结论

该分支实现了显式详细日志模式，并保持非 verbose 行为兼容。目标测试和全量测试均已
通过。合入 main 后，调试 Harness run 时可以用 `--verbose` 同时获得实时诊断和持久
JSONL 记录。

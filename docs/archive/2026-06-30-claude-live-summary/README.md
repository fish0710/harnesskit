# Claude Live Summary Archive

归档日期：2026-06-30

当前分支：`feat/claude-live-summary`

合入目标：`main`

## 背景

Harness 的 Daytona Claude driver 已经把 Claude `stream-json` 输出写入远端
`claude-stream.jsonl`，并由 host-side tailer 解析成
`agent.claude.text`、`agent.claude.tool`、`agent.claude.result` 和
`agent.command.progress` 观测事件。

问题是默认 CLI 输出仍把这些事件当作普通 JSON observation 打印，使用者很难从终端
直接看出 Claude 正在读文件、写文件、输出结论，容易误以为只能等 command 完成后
才知道结果。

## 最终机制

- 新增 `renderSandboxObservation(event, data)`，集中渲染 sandbox observation。
- 非 verbose `harness run --driver claude` 继续实时打印 sandbox observations，但对
  Claude stream 事件使用可读摘要：
  - `agent.claude.text` -> `Claude: <summary>`
  - `agent.claude.tool` -> `Claude tool: <tool> ...`
  - `agent.command.progress` -> `Claude progress: <event> ... <bytes>`
  - `agent.claude.result` -> `Claude result: session=... turns=...`
- 未识别事件仍保留原来的 compact JSON observation 输出。
- verbose 模式保持既有行为：sandbox events 写入 diagnostic log，不额外刷默认终端。
- 不透传 raw `stream-json`，避免默认终端输出过量和泄露完整上下文。

## 交付物

| 产出 | 路径 |
|---|---|
| CLI observation renderer | [cli.ts](../../../src/cli.ts) |
| CLI renderer regression | [cli-redaction.test.ts](../../../test/cli-redaction.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 真实运行证据

在临时 fixture `/private/tmp/harness-live-summary.U1s45A` 中运行本分支构建出的 CLI：

```bash
node /Users/zhongyy40/workspace/harnesscli/harness/.worktrees/claude-live-summary/dist/src/cli.js \
  run "Change src/result.txt to exactly passed. Keep scope minimal; only edit src/result.txt." \
  --driver claude \
  --dir contracts \
  --config harness.config.json \
  --max-attempts 1
```

终端在 `agent.command.end` 前显示了 live summary：

```text
· Claude progress: system · 1275 bytes parsed
· Claude progress: assistant · 1732 bytes parsed
· Claude tool: Read path="/home/daytona/workspace/candidate/src/result.txt"
· Claude tool: Write path="/home/daytona/workspace/candidate/src/result.txt"
· Claude: Done. src/result.txt now contains exactly `passed`.
· Claude result: session=61776d7b-9899-438e-822a-9fed1a3c88b3 · turns=3 · durationMs=9371 · durationApiMs=11606 · ttftMs=2916
```

RunStore 记录：

```text
/private/tmp/harness-live-summary.U1s45A/.harness/runs/2026-06-30T02-08-37-895Z-6b05c78c.json
```

该 run 后续在 candidate integrity 阶段因 Daytona 网络/TLS 断连升级，但 Claude live
summary 已在 Agent command 结束前出现并记录到 RunStore。

## 归档结论

A 方案已落地：默认终端输出现在能实时显示 Claude 安全摘要，而不改变远端 command
执行模型、不引入 raw stream-json 透传。构建、定向测试、全量测试和真实运行验证均
完成。

# Daytona Claude Transcript Persistence Archive

归档日期：2026-06-22

当前分支：`main`

## 背景

本轮排查目标是修正 `--driver claude` 的 Daytona observability artifact
持久化方式。早期实现把 Claude state 指向 mounted volume 后，RunStore 能定位
volume，但 native `.claude/projects/<session>.jsonl` 里只剩 queue/user/
attachment 启动事件，缺少 assistant、tool_use 和 tool_result。

实测确认：`claude -p --output-format stream-json --verbose` 本身会写完整会话；
问题出在把 Daytona volume 直接作为 `$HOME/.claude` 或 `CLAUDE_CONFIG_DIR`
使用时，Claude Code native JSONL 会变成不完整启动记录。

## 最终机制

- Agent sandbox 只把 run root volume subpath `runs/<runId>` 挂到
  `/harness-observability`。
- Harness 不再设置 `CLAUDE_CONFIG_DIR`。
- Claude Code 运行时继续写 sandbox-local `/home/daytona/.claude`。
- 远端 Claude shell command 把完整 `stream-json` stdout 直接写到
  `/harness-observability/attempt-<n>/claude-stream.jsonl`，然后 cat 回 stdout，
  供 Harness 继续解析 session id。
- Claude command 结束后，Harness 在删除 Agent sandbox 前复制
  `/home/daytona/.claude/.` 到 `/harness-observability/.claude/`。
- RunStore attempt 记录 `claudeConfigDir`、`claudeStreamPath`、Agent sandbox id、
  Claude session id、Gate sandbox ids 和 Gate outcome。
- harness-prep plugin skill 的 observability 查看流程同步改为挂载 run root，
  查看 copied native `.claude` 和 raw stream JSONL。

## 关键路径

```text
.harness/runs/<runId>.json
Daytona volume: harness-claude-observability
Volume subpath: runs/<runId>
Mounted run root: /harness-observability
Claude native state while running: /home/daytona/.claude
Copied native state after command: /harness-observability/.claude
Raw stream transcript: /harness-observability/attempt-<n>/claude-stream.jsonl
```

删除 Agent sandbox 后，创建临时 inspection sandbox，仍然只把
`runs/<runId>` 挂到 `/harness-observability`。不要把 volume 直接挂到
`/home/daytona/.claude`。

## 交付物

| 产出 | 路径 |
|---|---|
| 当前架构设计 | [daytona-sandbox-gate.md](../../architecture/daytona-sandbox-gate.md) |
| Daytona/Langfuse 边界说明 | [daytona-langfuse-observability.md](../../architecture/daytona-langfuse-observability.md) |
| 本地/远端运行手册 | [daytona-local-claude-code-runbook.md](../../daytona-local-claude-code-runbook.md) |
| Harness Prep skill observability 流程 | [observability-and-review.md](../../../plugins/harness-prep/skills/harness-prep/references/observability-and-review.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 已解决问题

1. 不再把 Daytona volume 直接挂到 `$HOME/.claude`。
2. 不再依赖 `CLAUDE_CONFIG_DIR` 影响 Claude Code native transcript 路径。
3. sandbox 删除前复制 native `.claude` 到 run-scoped durable volume。
4. 每个 attempt 独立持久化 raw `stream-json` transcript。
5. RunStore 保存 `attempts[].claudeStreamPath`，便于 timeout/失败后定位最后活动。
6. plugin skill 的排障流程不再误导为“复制到 Harness host”或“直接挂 HOME”。

## 归档结论

代码、测试、文档和 plugin skill 已同步到新的持久化机制。当前分支已经是 `main`，
因此没有 feature branch 需要合入。后续只需要按部署流程把当前 `main` 推送到远端。

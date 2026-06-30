# Retained Sandbox Resume Archive

归档日期：2026-06-30

当前分支：`retained-sandbox-resume-plan`

合入目标：`main`

## 背景

`sandbox.retainOnFailure: true` 可以保留 Daytona Agent sandbox，但旧流程只会
在同一个本地 Harness orchestrator 进程内继续使用它。如果本地进程被 Ctrl-C
中断，远端 Claude Code 可能已经完成任务，RunStore 却仍停在 `running`，没有
进入 Gate、发布和 series ledger 更新。

本轮目标是把这种保留 sandbox 场景做成显式、保守、可验证的恢复流程。

## 最终机制

- 新增 `harness runs resume <runId>`，普通 `harness run` 不会隐式复用旧 sandbox。
- resume 只支持 `daytona(claude)` 的 escalated run，或本地 orchestrator 被中断
  后仍为 `running` 且 outcome 为空的 run。
- resume 前校验 source run 记录的 clean/dirty 和 Git HEAD 必须已知，当前 HEAD
  必须匹配，当前源码工作区必须 clean；`.harness` 运行记录不计入 dirty。
- Daytona provider 支持按 `agentSandboxId` attach 既有 sandbox。
- 如果 source run 没有 `claudeSessionId`，resume 会读取 retained sandbox 中的
  `claudeStreamPath`，从成功的 `result` 事件恢复 `session_id` 或 `sessionId`。
- 恢复到既有 sandbox 后先跑 Gate，再决定是否发布或继续 `claude --resume`。
- 成功发布后删除 retained sandbox；resume 失败仍保留 sandbox。
- series-task resume 成功后只把匹配 source run 的 `running`/`escalated` ledger
  task 标为 `ready_to_commit`，避免旧 run 覆盖已完成或更新的 ledger 状态。

## 交付物

| 产出 | 路径 |
|---|---|
| resume request validation | [resume.ts](../../../src/harness/resume.ts) |
| Daytona attach/recovery | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| CLI resume command | [cli.ts](../../../src/cli.ts) |
| series ledger update helper | [series.ts](../../../src/harness/series.ts) |
| 使用说明 | [usage.md](../../../docs/usage.md) |
| Daytona runbook | [daytona-local-claude-code-runbook.md](../../../docs/daytona-local-claude-code-runbook.md) |
| 验证记录 | [verification.md](verification.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |

## 归档结论

保留 sandbox 恢复能力已落地。针对人工中断本地 Harness orchestrator、远端 Claude
已完成但 host 未采集/未 Gate 的场景，现在可以通过 source RunStore metadata
重新 attach sandbox、恢复 Claude session、Gate-first 验证候选、发布或继续 resume。

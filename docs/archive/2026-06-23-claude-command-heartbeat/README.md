# Claude Command Heartbeat Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮需求解决 `harness run --driver claude` 在 Agent sandbox 执行 Claude
Code 命令时缺少实时存活信号的问题。Claude command 阶段可能长时间没有
stdout/stderr 输出，但模型和工具调用仍在远端 sandbox 内继续执行。没有明确
host-side liveness signal 时，监督 agent 容易把正常运行误判为卡死。

需求目标不是实时展示 Claude Code 具体做了什么，而是在 run 阶段给出可观察、
可持久化、可被 skill 正确解释的信号：只要 heartbeat 持续，说明远端 Claude
command 进程仍未结束；heartbeat 停止后，再结合后续 command end、error、
candidate collect 或 gate 事件判断状态。

## 最终机制

- 新增 host-side command heartbeat helper，在远端 Claude command promise
  pending 期间按固定间隔发出 `agent.command.heartbeat`。
- Daytona Claude run 路径把 heartbeat 绑定到原始 `handle.execute(...)`
  command 生命周期，而不是绑定到后续 stream tail/collect 流程。
- command settlement 后 heartbeat 停止；后续慢速 stream 读取、candidate
  collection 或 gate 流程不会继续伪造 Claude command 存活。
- RunStore attempt 折叠最新 heartbeat：
  - `attempts[].commandLastHeartbeatAt`
  - `attempts[].commandLastHeartbeatElapsedMs`
- harness-prep skill 文档明确：heartbeat 只是 liveness signal，不证明 Claude
  语义进展；没有输出但 heartbeat 持续是正常状态。
- 本地 plugin marketplace 已加入，便于快速刷新并安装 harness-prep plugin。

## 交付物

| 产出 | 路径 |
|---|---|
| 设计说明 | [2026-06-22-claude-command-heartbeat-design.md](../../superpowers/specs/2026-06-22-claude-command-heartbeat-design.md) |
| 执行计划 | [2026-06-22-claude-command-heartbeat.md](../../superpowers/plans/2026-06-22-claude-command-heartbeat.md) |
| Heartbeat helper | [command-heartbeat.ts](../../../src/harness/command-heartbeat.ts) |
| Daytona run 集成 | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| RunStore 折叠字段 | [record.ts](../../../src/harness/record.ts) |
| Skill 监督指引 | [run-supervision.md](../../../plugins/harness-prep/skills/harness-prep/references/run-supervision.md) |
| Skill 阻塞判断指引 | [blocker-analysis.md](../../../plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md) |
| RunStore 观测字段说明 | [runstore-observability.md](../../../plugins/harness-prep/skills/harness-prep/references/runstore-observability.md) |
| Plugin marketplace | [marketplace.json](../../../.agents/plugins/marketplace.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 已解决问题

1. Claude command 长时间静默时，supervisor 可以通过 heartbeat 判断远端命令仍在运行。
2. RunStore 保存最新 heartbeat 时间和 elapsedMs，run 结束后仍能复盘。
3. harness-prep skill 不再把没有 Claude stdout 直接当成卡死。
4. heartbeat 生命周期绑定到真实 command，避免 command 已结束但 tail/collect
   仍慢时继续报告存活。
5. 本地 harness-prep plugin 可通过 harnesskit marketplace 快速更新安装。

## 真实项目验证结论

在 `/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab` 使用更新后的 CLI 和
plugin 进行了真实 run 验证。

关键证据：

```text
runId: 2026-06-22T10-24-37-318Z-0d533de0
agentSandboxId: 038cf147-fd09-4fe6-80f3-d991cf8664a9
heartbeat elapsedMs: 30002, 60003, 90004, 120005
commandLastHeartbeatAt: 2026-06-22T10:27:57.864Z
commandLastHeartbeatElapsedMs: 120005
Claude command endedAt: 2026-06-22T10:28:20.275Z
Claude command exitCode: 0
```

该 run 证明 Claude command 阶段能持续发出 heartbeat，且 command 正常结束后
不会继续把 heartbeat 当成活动信号。

后续 run outcome 为 `escalated`，原因是 Claude command 成功结束后，
candidate collect 阶段遇到 Daytona/TLS 错误：

```text
Client network socket disconnected before secure TLS connection was established
```

这个错误属于 Daytona 网络/候选收集阶段的稳定性问题，不是 heartbeat 需求失败。

## 归档结论

代码、测试、skill 文档、plugin marketplace 和真实项目验证均已完成。当前分支
已经是 `main`，本归档补齐该需求的最终证据链。后续如继续提升稳定性，应单独
跟进 Daytona/TLS transient error 的 retry、分类和可恢复策略。

# Daytona Agent Workspace Path Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮排查来自真实 Daytona Agent sandbox：

```text
agentSandboxId: 35c74174-1946-48a0-a5af-7cbd11b52c7f
runId: 2026-06-23T08-26-56-063Z-ea94df62
```

RunStore 显示该 sandbox 是原始 Agent sandbox，且已经完成：

```text
agent.create.end role=agent
agent.upload.end files=5
agent.preflight.end exitCode=0
agent.command.start claudeConfigDir=/home/daytona/.claude
```

但用户在交互 shell 的 `/` 下看不到 `/workspace`。进一步验证后确认，
Harness 内部逻辑路径和 Daytona 交互 shell 视角不同：

| Surface | Path |
|---|---|
| Harness logical remote root | `/workspace/candidate` |
| Daytona SDK file/process path | `workspace/candidate` |
| Interactive Agent shell cwd | `/home/daytona/workspace/candidate` |
| Claude native state | `/home/daytona/.claude` |
| Claude observability mount | `/harness-observability` |

此前文档和 skill 容易让读者去 root-level `/workspace/candidate` 查项目文件。

## 修正范围

- `harness-prep` skill references 新增 Agent workspace path 指引。
- `docs/usage.md` 和 Daytona 架构文档明确交互 shell 路径。
- `REMOTE_ROOT` 相关源码注释说明它是 Harness logical root，不是 shell 绝对路径。
- 历史 spec/plan 中仍需保留 `/workspace/candidate` 的测试/设计片段补充限定说明。

## 交付物

| 产出 | 路径 |
|---|---|
| Skill Agent 环境指引 | [agent-environment.md](../../../plugins/harness-prep/skills/harness-prep/references/agent-environment.md) |
| Skill 观测/排查指引 | [observability-and-review.md](../../../plugins/harness-prep/skills/harness-prep/references/observability-and-review.md) |
| Usage 文档 | [usage.md](../../../docs/usage.md) |
| Daytona 架构文档 | [daytona-sandbox-gate.md](../../../docs/architecture/daytona-sandbox-gate.md) |
| Run environment 注释 | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| Preflight 注释 | [preflight.ts](../../../src/harness/preflight.ts) |
| Workspace collector 注释 | [workspace.ts](../../../src/harness/sandbox/workspace.ts) |
| Plugin manifest | [plugin.json](../../../plugins/harness-prep/.codex-plugin/plugin.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

`/workspace/candidate` 继续作为 Harness 内部 logical root 保留；面向人工排查和
交互 shell 的说明统一改为 `/home/daytona/workspace/candidate`。


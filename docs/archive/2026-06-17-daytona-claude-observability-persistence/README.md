# Daytona Claude Observability Persistence Archive

> 归档日期：2026-06-17
>
> 实现分支：`codex/agent-observability-persistence`
>
> 最终实现提交：`b5c0a0e`

## 归档目的

本目录记录 Daytona `--driver claude` 默认持久化 `.claude` artifact 的实现、
验证结果和部署侧注意事项。

本轮目标是补齐远端 Agent sandbox 删除后的可观察性：即使 Langfuse 无法注入
远端 Claude CLI，Harness 仍能通过 host run manifest 和 Daytona volume 关联
任务、sandbox、attempt、Gate 结果和 Claude Code 会话文件。

## 交付物

| 产出 | 路径 |
|---|---|
| 当前架构设计 | [daytona-sandbox-gate.md](../../architecture/daytona-sandbox-gate.md) |
| Daytona/Langfuse 边界说明 | [daytona-langfuse-observability.md](../../architecture/daytona-langfuse-observability.md) |
| 本地/远端运行手册 | [daytona-local-claude-code-runbook.md](../../daytona-local-claude-code-runbook.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 最终系统形态

- `harness run --driver claude` 默认开启 Daytona artifact persistence；
- CLI 在远端 provider/agent 创建前写入 `.harness/runs/<runId>.json`；
- Agent sandbox 挂载 Daytona volume `harness-claude-observability`；
- volume subpath 为 `runs/<runId>`，sandbox 内挂载点为 `/harness-observability`；
- 每轮 Claude attempt 使用
  `/harness-observability/attempt-<n>/.claude` 作为 `CLAUDE_CONFIG_DIR`；
- run manifest 持久记录 raw observation events、agent/gate sandbox ids、
  attempt、Gate outcome、错误原因和 durable volume run root；
- Gate sandbox 不接收 observability volume、模型凭证或 Langfuse 凭证；
- `HARNESS_DAYTONA_OBSERVABILITY=0` 可显式关闭 volume persistence，但 run
  manifest 仍记录 disabled 状态。

## 关键路径

```text
.harness/runs/<runId>.json
/harness-observability/runs/<runId>
/harness-observability/attempt-<n>/.claude
```

由于 volume mount 的 subpath 已经是 `runs/<runId>`，Agent sandbox 内看到的
run root 是 `/harness-observability`，host manifest 中记录的 durable root 是
`/harness-observability/runs/<runId>`。

## 已解决问题

1. 远端 Daytona Claude CLI 绕过 host Claude Agent SDK instrumentation，无法被
   host Langfuse 直接观测。
2. Agent sandbox 正常清理后，默认 `~/.claude` 记录会随 sandbox 消失。
3. 早期 provider/config/command 失败以前没有稳定 run manifest 可查。
4. Gate sandbox 不应因为观测能力而获得额外 volume 或凭证。
5. raw observation events 需要持久化，同时 console 输出仍保持脱敏。

## 部署侧前置条件

Daytona runner 必须具备 volume mount 能力。当前验证环境的修复方式是部署
本地 runner 镜像，安装 `mount-s3 1.22.3`、FUSE 运行库，并通过 wrapper 为
MinIO/S3-compatible endpoint 补齐 `--force-path-style`。

缺少该能力时，默认 observability 路径会在 Agent sandbox 创建阶段失败，并在
run manifest 中记录错误。可用
`HARNESS_DAYTONA_OBSERVABILITY=0` 临时绕过 volume persistence。

## 归档结论

代码、文档、单元测试、真实 Daytona Agent/Gate 集成、默认 volume persistence
CLI 成功路径，以及复挂 volume 读取 `.claude` 会话文件均已验证。本轮需求可以
合入。

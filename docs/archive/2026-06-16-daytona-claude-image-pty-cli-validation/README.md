# Daytona Claude Image / PTY / CLI Validation 归档

> 归档日期：2026-06-16
>
> 实现分支：`codex/daytona-claude-image-setup`
>
> 最终实现提交：`0b72601`

## 归档目的

本目录记录 Daytona Claude Agent 镜像预构建、远端 toolbox URL 修正、PTY
WebSocket 修正、r2 Snapshot 发布，以及在
`/Users/zhongyy40/workspace/test_harness` 中使用真实 CLI 的验证结果。

该归档补充 2026-06-15 的 sandbox gate 归档，重点是把 run 阶段安装 Claude
的行为移到 pinned Snapshot，并补齐之前缺失的真实远端 PTY 覆盖。

## 交付物

| 产出 | 路径 |
|---|---|
| 当前架构设计 | [daytona-sandbox-gate.md](../../architecture/daytona-sandbox-gate.md) |
| 本地/远端运行手册 | [daytona-local-claude-code-runbook.md](../../daytona-local-claude-code-runbook.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |
| `test_harness` CLI 实测 | [test-harness-cli-validation.md](test-harness-cli-validation.md) |

## 最终系统形态

- Claude Code 不在 `harness run` 阶段安装；
- 宿主通过 `HARNESS_DAYTONA_AGENT_SNAPSHOT` 显式选择 Agent Snapshot；
- 当前发布的 Snapshot 为 `harness-agent-claude-2.1.145-r2`；
- 镜像锁定 Node.js `22.14.0`、Claude Code `2.1.145` 和 `/usr/bin/bash`；
- Claude Agent 和 Gate 默认使用 Daytona HTTP `executeCommand` 主链路；
- PTY 已作为真实远端 opt-in integration test 覆盖；
- 远端 toolbox REST 和 PTY WebSocket 使用不同入口：
  - REST generated client: `/api/toolbox/<sandbox>/toolbox`
  - PTY SDK base: `/toolbox/<sandbox>`
- Gate 决策仍在宿主，Gate sandbox 不接收 agent、模型凭证或 Agent Snapshot。

## 已解决问题

1. 远端 Daytona 返回 `proxy.localhost:4000` 时，harness 兼容改写 REST
   generated client base URL，使 HTTP `executeCommand` 可用。
2. PTY WebSocket 不再错误走 deprecated `/api/toolbox/.../connect`，而是保留
   SDK 期望的公网 `/toolbox/<sandbox>/.../connect`。
3. Snapshot 从 `r1` 修订到 `r2`，显式保证 `/usr/bin/bash` 存在，避免 PTY
   启动失败。
4. 新增 `npm run test:daytona:pty`，真实创建远端 Agent sandbox、创建
   harness workspace、连接 PTY、执行 sentinel 命令并清理 sandbox。
5. `test_harness` 实测确认 CLI 的 Daytona Agent/Gate 链路可运行且无残留
   sandbox。

## 剩余边界

`test_harness` 没有通过业务门禁不是 Daytona 链路问题。当前
`harness.config.json` 的 `gateSetup` 为空，但 HTTP contracts 访问
`http://127.0.0.1:3000`，远端 Gate sandbox 中没有启动文件服务器，因此
HTTP 契约在远端为 error。

本机存在宿主进程监听 `:3000`，所以本地 `harness check` 会被宿主进程影响，
不能代表隔离 Gate 结果。

## 归档结论

Daytona Agent Snapshot、远端 toolbox URL、PTY WebSocket、HTTP
`executeCommand`、Agent/Gate 集成和 sandbox 清理均已真实验证。下一步若要让
`test_harness` 业务门禁通过，应修正该项目自己的门禁契约配置，例如在
`gateSetup` 中启动服务器并隔离 `uploads` 初始状态。

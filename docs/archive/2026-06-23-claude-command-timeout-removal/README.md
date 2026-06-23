# Claude Command Timeout Removal Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

真实 `harness run --driver claude` 中，Claude Code 可能连续数小时处理一个任务。
当前 Daytona Claude 主命令固定传入 20 分钟执行超时：

```text
request timeout: command execution timeout
```

这会把长时间静默但仍在工作的 Claude command 误杀。此前已经加入
`agent.command.heartbeat` 作为 host-side liveness signal，因此主命令不需要再用
固定 20 分钟 timeout 判断是否卡死。

## 最终机制

- Daytona Claude 主命令调用 `handle.execute(command, REMOTE_ROOT, commandEnv)`，
  不再传 `timeoutMs`。
- Claude command 仍由 host-side heartbeat 报告存活状态。
- setup/preflight/Gate 等短生命周期步骤保留现有 timeout：
  - Claude toolchain preflight：30 秒；
  - Agent setup：10 分钟；
  - Gate setup：10 分钟；
  - command driver PTY 默认超时保持不变。
- 失败路径仍会 emit `agent.command.end` with `outcome: "error"`，并尝试复制
  Claude home snapshot。

## 交付物

| 产出 | 路径 |
|---|---|
| Daytona run 集成 | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| 回归测试 | [daytona-environment.test.ts](../../../test/daytona-environment.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 行为边界

本次只移除 Claude 主命令的固定执行超时，不改变：

- run budget `--max-ms`；
- command driver PTY timeout；
- Gate contract timeout；
- setup/preflight timeout；
- stream-json transcript persistence；
- command heartbeat 和 RunStore 记录语义。

## 归档结论

Claude 主命令不再被 Harness 的 20 分钟 timeout 打断，适配数小时级任务。其他受控
步骤仍保留 bounded timeout，避免 setup、preflight 或 Gate 阶段无界等待。

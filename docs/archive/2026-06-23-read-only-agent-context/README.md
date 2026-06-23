# Read-Only Agent Context Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮修正 Harness sandbox 配置的信任边界。此前 Harness 只有两类有效路径：

- `candidateRoots`：上传给 Agent，并可作为候选变更发布。
- `protectedPaths`：不可发布，同时也不上传给 Agent。

这导致 `protectedPaths` 实际语义更接近 host-only/hidden，而不是 read-only。任务上下文
如 `AGENTS.md`、`docs/specs/`、`docs/plans/` 不适合隐藏；但放进 `candidateRoots`
又会让 Agent 可以修改并发布它们。

## 最终机制

- 新增 `sandbox.readOnlyPaths`。
- `candidateRoots`：Agent 可见、可改、可发布。
- `readOnlyPaths`：Agent 可见，但候选收集会校验不变；新增、删除、修改都会变成
  candidate integrity error。
- `protectedPaths`：host-owned/hidden，不上传给 Agent，也不能发布。
- 路径分类优先级为 protected -> read-only -> candidate -> ignored。
- Gate sandbox 和 host-local gate materialization 只移除/覆盖 mutable candidate
  baseline，read-only 文件保持 host baseline 并作为 host-controlled 文件验证。
- scaffold 和示例配置默认把 `AGENTS.md`、`docs/specs`、`docs/plans` 放入
  `readOnlyPaths`。
- `harness-prep` plugin/skill 指引已更新，未来准备 Harness run 时应明确区分
  candidate、read-only context、protected/hidden 三类路径。
- harness-prep plugin cachebuster 刷新为 `0.1.0+codex.20260623081235`，并从本地
  `harnesskit` marketplace 重新安装到 Codex。

## 交付物

| 产出 | 路径 |
|---|---|
| Policy model | [types.ts](../../../src/harness/sandbox/types.ts), [policy.ts](../../../src/harness/sandbox/policy.ts) |
| Workspace capture/collection | [workspace.ts](../../../src/harness/sandbox/workspace.ts) |
| Daytona run environment | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| Gate materialization | [host-gate.ts](../../../src/harness/host-gate.ts), [preflight.ts](../../../src/harness/preflight.ts) |
| Scaffold/default config | [scaffold.ts](../../../src/harness/scaffold.ts), [examples](../../../examples/harness.config.json) |
| Harness docs | [README.md](../../../README.md), [usage.md](../../../docs/usage.md), [architecture](../../../docs/architecture/daytona-sandbox-gate.md) |
| Harness Prep skill | [SKILL.md](../../../plugins/harness-prep/skills/harness-prep/SKILL.md) |
| Prep references | [agent-environment.md](../../../plugins/harness-prep/skills/harness-prep/references/agent-environment.md), [contracts-and-config.md](../../../plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md) |
| Design spec | [design](../../../docs/superpowers/specs/2026-06-23-read-only-agent-context-design.md) |
| Implementation plan | [plan](../../../docs/superpowers/plans/2026-06-23-read-only-agent-context.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 设计结论

`protectedPaths` 不应承担 read-only 语义。它应继续保护裁判和宿主控制面，例如
`contracts/`、`test/gates/`、`.harness/`、`harness.config.json`、CI 和 CODEOWNERS。
任务上下文应放入 `readOnlyPaths`，这样 Agent 能读到要求和计划，但无法把这些文件作为
候选变更发布。

## 归档结论

本轮把 read-only context 做成 Harness policy 的一等能力，并同步更新运行时、测试、
scaffold、文档和 harness-prep plugin/skill。Codex 本地安装缓存已通过 plugin
reinstall 刷新到新 cachebuster。

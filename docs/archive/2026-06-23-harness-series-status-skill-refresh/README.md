# Harness Series Status And Skill Refresh Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮修复来自一次 Harness 真实运行中的几个易误判点：

- `harness-prep` skill 仍把手动 `harness preflight gate` 写成 pre-run
  checklist 的固定动作，但当前 Daytona-backed `harness run` 已经会在创建
  Agent 前自动执行同一 Gate readiness barrier。
- 配置任务序列中，`.harness/series/<series-id>.json` 已把任务标记为
  `completed` 且 `taskHash` 未变化时，`harness run` 会在创建 child run、
  Agent sandbox、Gate sandbox 和内置 preflight 前直接跳过任务。
- 旧 CLI 输出只显示 `✓ series completed`，没有说明 completed task 被跳过。
- `harness status` 通过 legacy `lastRunRecord` 摘要选择最近 run，可能显示旧的
  escalated child，而 `runs list/show` 和 series ledger 已经显示当前 series
  completed。
- `.harness/runs` 是历史审计记录，`.harness/series/*.json` 才是 series
  resume/skip/commit 状态依据。
- 当前 dependency 类任务应使用 `--changed` 限定检查范围，避免不相关慢 gate。
- `autoCommit.enabled=false` 时，series completed 不代表已经创建 git commit。

## 最终机制

- `runTaskSeries` 增加 `onTaskSkipped` hook，在 completed matching task 被跳过时
  向 CLI 暴露 task/index/ledger 信息。
- `harness run` 对 skipped completed task 输出：

```text
[1/1] <task-id> · skipped completed (taskHash unchanged)
```

- series parent run logs 会记录 `skipped completed tasks: ...`，让 RunStore 审计也
  能解释为什么没有 child run。
- `harness status` 现在优先读取 v3 `RunStore`，按 `updatedAt` 选择最新 run，并在
  摘要里展示 `kind`、`status/outcome`；只有没有 v3 记录时才回退 legacy
  `lastRunRecord`。
- `harness-prep` skill 和引用文档更新为：
  - 手动 `harness preflight gate` 是可选诊断，不是每次 run 前的必做步骤；
  - completed + matching `taskHash` 会在 Agent/Gate/preflight 前 skip；
  - RunStore 和 series ledger 不能混用；
  - 已知变更文件时优先 `--changed`；
  - `autoCommit.enabled=false` 不暗示 git commit。
- harness-prep plugin cachebuster 刷新为 `0.1.0+codex.20260623020020`，并从本地
  `harnesskit` marketplace 重新安装。

## 交付物

| 产出 | 路径 |
|---|---|
| Series skip hook | [series.ts](../../../src/harness/series.ts) |
| CLI skip 输出和 parent logs | [cli.ts](../../../src/cli.ts) |
| Status v3 RunStore 摘要 | [status.ts](../../../src/harness/status.ts) |
| CLI series regression | [cli-series.test.ts](../../../test/cli-series.test.ts) |
| Status regression | [status.test.ts](../../../test/status.test.ts) |
| Skill 主说明 | [SKILL.md](../../../plugins/harness-prep/skills/harness-prep/SKILL.md) |
| Run supervision 指引 | [run-supervision.md](../../../plugins/harness-prep/skills/harness-prep/references/run-supervision.md) |
| RunStore/ledger 指引 | [runstore-observability.md](../../../plugins/harness-prep/skills/harness-prep/references/runstore-observability.md) |
| Blocker analysis 指引 | [blocker-analysis.md](../../../plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md) |
| Plugin manifest | [plugin.json](../../../plugins/harness-prep/.codex-plugin/plugin.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## Review Result

归档前派发 subagent review。Review 没有发现阻塞性实现问题。唯一 medium finding 是
`test/status.test.ts` 当时处于 untracked 状态，提交时必须包含；本归档和最终 commit
把该测试纳入版本控制。

剩余风险：当前 skip 可见性测试覆盖 all-skipped completed path，没有额外覆盖
“先 skip completed task，后续 task blocked/error”的 mixed path。该风险不影响本轮
修复目标，因为 skip hook 在通用 `decision.action === "skip"` 分支触发。

## 归档结论

代码、测试、skill 文档和 plugin cache 刷新已对齐当前 Harness 行为。后续如果继续
改进，可以考虑给 mixed series path 增加额外 CLI 输出断言，但本轮修复已覆盖真实
误判路径。

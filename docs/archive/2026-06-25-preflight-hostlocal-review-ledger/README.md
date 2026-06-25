# Preflight Host-Local Review Ledger Archive

归档日期：2026-06-25

工作分支：`fix/preflight-hostlocal-review-ledger`

## 背景

这次修复覆盖两个真实 Harness 工作流问题：

1. 微信小程序真实自动化门禁被建模成 `type: command`，导致
   `harness preflight gate` 把它当远端 Daytona Gate 合同执行。该门禁依赖
   macOS 宿主机上的微信开发者工具，不能在远端 Linux Gate sandbox 中正确运行。
2. `review` 合同已通过 `harness review --resolve` 写入 verdict 后，series
   ledger 中对应 task 仍是 `blocked`，`harness run --driver scaffold` resume
   会先看 ledger 并直接停止，导致 GateCore 没机会用 stored verdict 解析 review。

## 最终机制

- `type: command` 仍保持远端 Gate sandbox 语义，不新增通用 host-local command。
- `runGatePreflight()` 在静态阶段识别含小程序自动化信号的 command 合同，并以
  readiness error 阻断，不创建 Daytona Gate sandbox。
- 小程序行为门禁的正确建模仍是 `type: miniprogram`，使用 `projectPath`、
  `runner` 和 `devtools`。
- `decideTaskResume()` 新增显式 `hasResolvedReviewVerdict` 输入。只有
  `blocked`、task hash 未变、且调用方确认 selected review 合同已有 verdict
  时才允许重新 `run`。
- `runTaskSeries()` 对 blocked/hash 未变任务预选 contracts，读取
  `.harness/verdicts.json`，仅在 selected `review` 合同有 matching verdict
  时解锁重跑。`escalated` 和 `error` 仍保持人工处理。

## 交付物

| 产出 | 路径 |
|---|---|
| Design spec | [spec](../../../docs/superpowers/specs/2026-06-25-preflight-hostlocal-review-ledger-design.md) |
| Implementation plan | [plan](../../../docs/superpowers/plans/2026-06-25-preflight-hostlocal-review-ledger.md) |
| Preflight modeling lint | [preflight.ts](../../../src/harness/preflight.ts) |
| Series resume logic | [series.ts](../../../src/harness/series.ts) |
| Preflight regression tests | [preflight-runtime.test.ts](../../../test/preflight-runtime.test.ts) |
| Series regression tests | [harness-series.test.ts](../../../test/harness-series.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

小程序真实自动化是 host-local 行为门禁，不能由普通 command 合同隐式代表。
Harness 现在会在 preflight 阶段快速指出建模错误，而不是把问题带进远端 Gate
sandbox。人工 review 的 verdict 仍由 GateCore 正常解析，但 series resume 现在能在
安全条件满足时让 blocked task 重新进入 GateCore。

## Residual Risk

- 静态小程序 command 识别使用强信号，目标是拦住明显误建模合同，不尝试猜测所有
  可能的小程序脚本。
- 已存在的误建模项目仍需要把 YAML 改为 `type: miniprogram`。
- invalid verdict option 仍会在重跑时由 GateCore 判为 error，这是预期的
  fail-closed 行为。

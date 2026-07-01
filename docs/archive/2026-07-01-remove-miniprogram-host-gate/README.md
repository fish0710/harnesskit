# Remove MiniProgram Host Gate Archive

归档日期：2026-07-01

当前分支：`main`

合入目标：`main`

合入方式：本次工作直接在普通仓库 `main` 分支完成提交，无独立 feature
worktree 或待合并分支。

## 背景

Harness 曾内置 `type: miniprogram` 小程序 host-local 门禁，用于在 macOS
宿主机连接微信开发者工具，同时让 Daytona Agent 和远端 Gate 沙箱继续保持隔离。

归档记录显示该能力持续要求额外维护：DevTools managed/connect 启动、WebSocket
readiness、宿主临时候选工作区、runner 依赖注入、artifact-first 指引、以及
preflight 对误建模 command 合同的拦截。该执行域过于不稳定且过于专用，已不适合作为
Harness core 内置门禁能力。

## 最终机制

- `type: miniprogram` 不再是受支持的内置合同类型。
- 旧 `type="miniprogram"` 合同会在 contract validation 阶段 fail closed，并给出
  明确迁移提示。
- CLI 不再注册 `miniprogramPlugin`。
- package root 不再导出 `miniprogramPlugin` 或 host-local gate helper。
- Daytona `run` 不再按 host-local/remote 拆分机器门禁；机器合同走普通远端 Gate
  沙箱。
- `harness preflight gate` 不再执行 DevTools doctor 或 host-local readiness。
- `miniprogram-automator` 从依赖和 lockfile 中移除。
- 小程序示例、fixtures、runner 和专项测试已删除。
- live 文档、脚手架 runtime reference、harness-prep skill 不再指导创建
  `type: miniprogram`。

## 迁移路径

现有项目若仍需要微信小程序行为验证，应显式放在 Harness core 外部：

- 使用外部 CI、设备实验室或项目自有脚本运行微信开发者工具自动化。
- 只有在检查能于 Gate sandbox 内执行时，才用 `type: command` 表达，例如 artifact
  存在性、lint、单元测试或源码可复现构建。
- 需要宿主 GUI、人工判断或产品接受的场景，用 `type: review` 阻断并等待人工 verdict。

Harness 本次没有新增通用 `hostLocal: true` 逃生口，因为这会把相同的不稳定宿主执行
模型换名保留下来。

## 交付物

| 产出 | 路径 |
|---|---|
| Design spec | [spec](../../../docs/superpowers/specs/2026-07-01-remove-miniprogram-host-gate-design.md) |
| Implementation plan | [plan](../../../docs/superpowers/plans/2026-07-01-remove-miniprogram-host-gate.md) |
| Removed-type validation | [contracts.ts](../../../src/contracts.ts) |
| CLI plugin registration | [cli.ts](../../../src/cli.ts) |
| Public exports | [index.ts](../../../src/index.ts) |
| Daytona Gate environment | [environment.ts](../../../src/harness/sandbox/environment.ts) |
| Gate preflight | [preflight.ts](../../../src/harness/preflight.ts) |
| Scaffold runtime reference | [scaffold.ts](../../../src/harness/scaffold.ts) |
| Harness prep skill | [harness-prep](../../../plugins/harness-prep/skills/harness-prep/SKILL.md) |
| 验证记录 | [verification.md](verification.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |

## 归档结论

小程序 host-local 门禁已从 Harness core 中硬移除。历史 archive 保留旧能力脉络，
当前 runtime、依赖、示例和 live 指引不再暴露该功能；旧合同以明确 validation error
失败，避免静默通过或误入远端 Gate。

## Residual Risk

- 仍使用 `type: miniprogram` 的外部仓库需要人工迁移。
- 外部 TypeScript 消费者若直接 import `miniprogramPlugin` 或 host-local helper，会在
  编译期失败。
- Preflight JSON 暂时保留 `hostLocalContracts: []` 字段作为报告兼容面；它不代表
  host-local gate 仍受支持。

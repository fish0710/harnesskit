# Harness Prep Serial Resume Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮来自一次真实 Harness serial task 恢复误判：

- 中途失败后，agent 把 `harness.config.json` 的 `series.id` 改成新值再跑，导致
  Harness 创建全新 `.harness/series/<series-id>.json` ledger。
- 新 ledger 没有已完成 task 的 `completed` 记录，因此从第一个 task 重新执行。
- 正确恢复方式是保留原 `series.id` 和原 ledger，修复根因后让 completed task
  通过 matching `taskHash` 自动 skip，再进入失败 task。
- 另一个误判点是把根 `package.json`、`package-lock.json` 等 setup 输入文件放入
  `candidateRoots`。Agent 发布了被修改的根依赖文件后，Gate setup 的根 `npm ci`
  在契约运行前失败。

## 最终机制

- `run-supervision.md` 新增 Interrupted Series Recovery：
  - 不通过改 `series.id` 绕过 stopped task；
  - 保留 completed task 的原 `taskHash` 和 ledger 记录；
  - 先修 config/setup/contracts/environment/root scope；
  - 只在根因修复后把 stopped task 恢复为 `pending` 或 `running`；
  - rerun 时必须看到 `skipped completed (taskHash unchanged)` 后再进入失败 task。
- `agent-environment.md` 和 `contracts-and-config.md` 明确根依赖文件、`.nvmrc`、
  `tsconfig.json`、Babel/PostCSS 配置默认是 setup 输入资产，不应因为 setup 运行
  `npm ci` 就放进 `candidateRoots`。
- `sandbox-snapshots.md` 增加 Dependency Manifest Boundaries，说明 Agent sandbox
  和 Gate sandbox 的安装命令必须指向同一组预期 manifests；隔离 app/subproject 应
  该用 `cd <subproject> && npm ci`，避免误跑根安装。
- harness-prep plugin cachebuster 刷新为 `0.1.0+codex.20260623034310`，并从本地
  `harnesskit` marketplace reinstall。

## 交付物

| 产出 | 路径 |
|---|---|
| Serial resume 指引 | [run-supervision.md](../../../plugins/harness-prep/skills/harness-prep/references/run-supervision.md) |
| Agent/Gate mutable scope 指引 | [agent-environment.md](../../../plugins/harness-prep/skills/harness-prep/references/agent-environment.md) |
| Config 模板和规则 | [contracts-and-config.md](../../../plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md) |
| Snapshot/setup manifest 指引 | [sandbox-snapshots.md](../../../plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md) |
| Plugin manifest | [plugin.json](../../../plugins/harness-prep/.codex-plugin/plugin.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 设计结论

Gate setup 在契约前失败时，优先按配置/环境边界问题处理。核心检查是：Agent 是否能
发布 Gate setup 会消费的 manifests 或 build config。默认应保护根 setup 输入文件；
只有任务明确要改依赖时，才把 manifest 和 lockfile 一起纳入候选，并把 Agent/Gate
setup 都限定到同一项目根。

## 归档结论

本轮没有改 Harness runtime 代码；变更集中在 harness-prep skill 和 plugin
cachebuster。已通过 plugin/skill 校验、TypeScript build、series regression 测试和
本地 plugin reinstall 验证。

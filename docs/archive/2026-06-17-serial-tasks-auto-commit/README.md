# Serial Tasks Auto Commit Archive

归档日期：2026-06-17

## 背景

本轮目标是让 Harness 能处理大型任务拆分后的串行执行：

- 在 `harness.config.json` 中配置多个 task；
- `harness run` 无位置参数时自动按顺序执行 task series；
- 每个 task 独立执行 `agent sandbox -> gate` loop；
- task 通过并发布到宿主后，按配置自动 `git commit`；
- 中断或重跑时通过 ledger 跳过已完成 task，避免重复执行；
- 每个 task 可配置对应 gate 契约；
- `harness create .` 在非 git 目录中自动 `git init`。

## 当前结论

串行任务能力已经接入 CLI：

- `harness run "<task>"` 仍保持单任务行为；
- `harness run` 会读取 `harness.config.json` 的 `tasks` 并串行执行；
- 每个 task 调用一次 `runSingleTask`，因此每个 task 都创建新的 Agent sandbox；
- task 内 gate 失败重试仍复用该 task 的 Agent sandbox；
- task gate selector 支持 `taskDefaults.gate` 与 task 自身 `gate` 合并；
- ledger 位于 `.harness/series/<seriesId>.json`；
- `completed` 且 hash 匹配的 task 会跳过；
- `ready_to_commit` 会先补 commit，不重新执行 agent；
- hash drift、blocked、escalated、error 会停住等待人工处理；
- auto commit 只提交发布结果中的 source files，排除 `.harness` runtime state。

## 主要改动

- 新增 `src/harness/series.ts`：
  - task series config parser；
  - task gate selection；
  - task hash；
  - ledger read/write/resume decision；
  - auto commit helper；
  - serial runner orchestration。
- `src/cli.ts`：
  - `harness run` 无 task 参数时执行 configured series；
  - 保留显式 task 的单任务行为。
- `src/harness/run.ts`：
  - 暴露 run publication result，供 auto commit 精确提交发布文件。
- `src/harness/scaffold.ts`：
  - `harness create .` 在非 git repo 中自动初始化 git。
- `src/harness/sandbox/daytona.ts`：
  - `ANTHROPIC_MODEL`、`ANTHROPIC_REASONING_MODEL` 改为可选；
  - 缺省时分别从 `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL` 派生。
- 文档：
  - README 与 usage 增加 serial tasks、resume、auto commit 说明；
  - 新增 `examples/serial-task-series/` 可运行示例；
  - Daytona Claude runbook 更新 optional model env 说明。

## 真实运行结论

### Command Driver Example

示例目录：

```text
examples/serial-task-series
```

真实运行临时仓库：

```text
/tmp/harness-serial-example.Xr29OB
```

结果：

- `extract-domain-model` 通过 gate，发布 `src/domain-model.ts`；
- `split-order-service` 通过 gate，发布 `src/order-service.ts`；
- ledger 状态为 `completed`；
- 同一目录重跑直接 `series completed`，验证 completed task skip。

该 example 的 `autoCommit.enabled` 为 `false`，因为它使用本地 command driver 作 smoke 示例。

### Real Claude Serial

真实运行临时仓库：

```text
/tmp/harness-claude-serial.bhAIpL
```

命令使用 `env -u ANTHROPIC_MODEL -u ANTHROPIC_REASONING_MODEL`，验证这两个变量不再必填。

结果：

- task 1 Agent sandbox：`52c426b1-ac84-4f08-9572-a400929f375a`
- task 1 Claude session：`8b0b14f2-3aaf-4b8b-a05c-470920017f1e`
- task 2 Agent sandbox：`f148aa19-11b1-4d19-9253-d3bcdccc3c65`
- task 2 Claude session：`58ef8cc1-232f-44e0-ad95-c56a4ccb6294`
- 两个 task 均有 `modelUsage` 和 `total_cost_usd`；
- 两个 gate 均 pass；
- ledger 状态为 `completed`。

### Real Claude Serial With Auto Commit

真实运行临时仓库：

```text
/tmp/harness-claude-serial-autocommit.boJzfd
```

实际 git history：

```text
8743269 claude serial autocommit baseline
b19e9ef harness serial: 1/2 write-domain-note
5f9aa2c harness serial: 2/2 write-service-note
```

这证明实际执行顺序为：

```text
agent1 -> gate1 -> git commit -> agent2 -> gate2 -> git commit
```

ledger 中对应：

```text
write-domain-note  -> b19e9ef9b108708a640e44ce6b492ef8b5188125
write-service-note -> 5f9aa2cda4a470a68c24db05a7363cca1f4ccc06
```

最终宿主 git status 仅剩 `.harness/` runtime state 未提交，`src/domain-note.txt` 与
`src/service-note.txt` 已分别进入对应 task commit。

## 注意事项

- `--driver claude` 使用 Harness Claude Agent snapshot，并运行 toolchain preflight；
- `--driver command` 当前不强制使用 Claude Agent snapshot。Node 脚本 command agent
  是否可用取决于对应 Daytona 默认运行环境；
- 因此仓库内 command example 使用 POSIX shell，避免对 Node runtime 的额外依赖；
- auto commit 依赖 sandbox publication result，不适合把本地 command driver 的 host-side
  直接修改当成发布结果。

## 后续建议

- 如果希望 `--driver command` 稳定支持 Node agent script，可增加 command driver snapshot
  配置或复用 Agent snapshot；
- 可在 CLI 输出中增加 `committed <sha>` 的显式提示，减少用户需要读 ledger/git log 的成本；
- 可增加一个 checked-in autoCommit example，但真实 Claude autoCommit 示例通常需要凭证，
  不适合做默认离线示例。

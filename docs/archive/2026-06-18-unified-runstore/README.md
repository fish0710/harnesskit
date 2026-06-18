# Unified RunStore Archive

归档日期：2026-06-18

## 背景

本轮目标是让 Harness 的 `run` 命令具备统一、持久、可追溯的运行记录：

- 单任务 `harness run "<task>"` 要写入 durable run record；
- configured task series 要写入 parent run record；
- 每个 series task 要写入 child run record；
- setup、contract、gate、Claude observability 等早期失败也要可追踪；
- `--driver claude` 的 Agent sandbox、Claude session、observability volume 信息要能从记录中定位；
- 支持通过 CLI 查询已持久化的 run 记录。

## 当前结论

统一 RunStore 已接入 `harness run`：

- Run record 写入当前 repo 的 `.harness/runs/<runId>.json`；
- 记录 schemaVersion 为 `3`；
- `kind` 区分 `single`、`series`、`series-task`；
- series parent 使用 `children` 记录 child run id、task id、index、status、outcome；
- series child 使用 `parentRunId`、`seriesId`、`taskId` 回链 parent 和业务 task；
- parent summary 从 series ledger/child 状态汇总；
- error run 使用 `status: "error"` 与 `outcome: "error"`；
- `lastRunRecord` 保持 legacy v1/v2 读取兼容。

## 保存内容

v3 run record 包含：

- repo：root、gitRoot、branch、head、dirty；
- task：description、taskId、seriesId、index、total；
- driver：scaffold、daytona(command)、daytona(claude)、series(...)；
- observability：volumeName、mountPath、runRoot；
- selectedContracts；
- attempts：agentSandboxId、claudeConfigDir、claudeSessionId、gateSandboxIds、gateOutcome；
- events；
- logs；
- Gate report；
- publication；
- summary、outcome、action、errorReason；
- series parent children。

## 查询入口

```bash
node dist/src/cli.js runs list --json
node dist/src/cli.js runs show <runId> --json
```

支持按 task 和 series 过滤：

```bash
node dist/src/cli.js runs list --task-id <taskId> --json
node dist/src/cli.js runs list --series-id <seriesId> --json
```

## Claude 追踪结论

正常 `--driver claude` run 中，RunStore 可定位：

```text
volume: harness-claude-observability
volume subpath: runs/<runId>
agent sandbox mount: /harness-observability
Claude config dir in sandbox: /harness-observability/.claude
Claude config dir in volume: runs/<runId>/.claude
Claude session id: attempts[].claudeSessionId
Agent sandbox id: attempts[].agentSandboxId
```

RunStore 保存索引和审计信息；`.claude` session 文件本体保留在 Daytona volume 中。

## 主要改动

- `src/harness/record.ts`
  - 新增 RunStore、RunRecordV3、kind-aware validation；
  - 新增 parent-side child references；
  - 扩展 completion/failure 记录内容；
  - 保持 v1/v2 lastRunRecord 兼容。
- `src/cli.ts`
  - `runSingleTask` 在 fallible setup 前创建 run record；
  - `harness run` series 创建 parent 与 child records；
  - 新增 `harness runs list/show`；
  - series setup failure 和 child selector failure 可落 error record。
- `src/harness/series.ts`
  - 新增 task setup error hook，支持 selector 失败时创建 child record。
- `src/harness/run.ts`
  - 发布失败时返回 publication result，供 RunStore 持久化。
- `README.md`
  - 增加 RunStore 和 series parent/child 记录说明。

## 明确边界

- 当前覆盖 `harness run`，不是所有 harness 子命令；
- `harness.config.json` 是配置来源，不存 run 结果；
- config 无法解析或没有 configured series 时，不伪造 unknown series run record；
- `.claude` session 文件不复制进 RunStore，只通过 runId、volume、sessionId 定位。

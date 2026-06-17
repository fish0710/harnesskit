# 提交账本

提交范围：`main..codex/agent-observability-persistence`

| 提交 | 内容 |
|---|---|
| `f1301f3` | 设计 Daytona Claude observability persistence |
| `af3b299` | 制定实现计划 |
| `2ecc4a0` | 新增 Daytona Claude observability config |
| `e206afb` | 新增 v2 incremental run recorder |
| `fe377ca` | 支持 Daytona sandbox volume mounts |
| `2fc54e3` | 注入 Claude observability paths 到 Daytona runs |
| `48069b4` | CLI 写入 Daytona Claude run observability records |
| `b5c0a0e` | 文档化 Daytona Claude artifact persistence |

## 变更规模

相对 `main`：

- 17 个文件发生变化；
- 新增约 4,288 行；
- 删除约 162 行；
- 新增 observability config、v2 run recorder、Daytona volume mount、CLI run
  manifest 集成、测试覆盖和文档。

## 关键代码边界

```text
src/harness/observability.ts
src/harness/record.ts
src/harness/sandbox/daytona.ts
src/harness/sandbox/environment.ts
src/harness/sandbox/types.ts
src/cli.ts
test/observability.test.ts
test/daytona-sandbox.test.ts
test/daytona-environment.test.ts
test/frozen-contract-callers.test.ts
```

## 关键修复链

### Observability Config

`HARNESS_DAYTONA_OBSERVABILITY` 默认开启。默认 volume 为
`harness-claude-observability`，sandbox mount path 为 `/harness-observability`。
配置入口校验 blank volume、unsafe mount、unsafe run id 和 invalid attempt。

### Run Manifest

CLI 在 Claude run 中创建 `runId` 和 v2 manifest，路径为
`.harness/runs/<runId>.json`。manifest 记录 raw observation events，并在成功、
失败和早期异常路径更新状态。

### Daytona Volumes

SDK provider 支持 `volumes`，在 sandbox create 前 resolve volume，并将
`volumeId`、`mountPath`、`subpath` 传给 Daytona SDK。unsafe volume name、mount
path 和 subpath 均 fail closed。

### Claude `.claude` Persistence

Agent sandbox 挂载 subpath `runs/<runId>`。每个 attempt 在 Claude command 前创建
`/harness-observability/attempt-<n>/.claude` 并注入 `CLAUDE_CONFIG_DIR`。
Gate sandbox 不接收 observability volume。

### CLI Integration

真实 `harness run --driver claude` 默认传入 observability options。console
observation 继续脱敏，persistent run manifest 保留 raw event data。

### Documentation

README、runbook、Daytona sandbox gate 架构和 Daytona/Langfuse 观测边界均已更新。
文档明确这是 artifact persistence，不是 Langfuse SDK tracing。

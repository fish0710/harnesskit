# 验证记录

## 本地自动化测试

验证命令：

```bash
npm test
```

2026-06-17 当前结果：

```text
tests 289
pass 289
fail 0
cancelled 0
skipped 0
todo 0
```

新增覆盖：

- Daytona Claude observability 默认开启、禁用和配置校验；
- run id、volume subpath、mounted sandbox path 校验；
- Daytona SDK provider volume resolve 和 unsafe mount/subpath fail closed；
- Agent sandbox 独占 observability volume，Gate sandbox 不接收 volume；
- Claude command 注入 `CLAUDE_CONFIG_DIR`、`HARNESS_RUN_ID`、`HARNESS_ATTEMPT`；
- observability setup start/end 和 command rejection error end event；
- CLI early failure v2 manifest，包括缺 Daytona key、invalid observability mount、
  invalid harness config；
- v2 run record 与 legacy v1 last-run compatibility。

## 真实 Daytona Agent/Gate 集成

验证命令：

```bash
source ~/.zshrc
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$ANTHROPIC_DEFAULT_SONNET_MODEL}"
export ANTHROPIC_REASONING_MODEL="${ANTHROPIC_REASONING_MODEL:-$ANTHROPIC_DEFAULT_OPUS_MODEL}"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
npm run test:daytona
```

结果：

```text
第 1 轮 · environment=daytona(claude)
driver: sandbox agent exited 0
门禁: pass(pass 1/1, fail 0, error 0, review 0)
PASS Daytona agent/gate integration
```

该测试实际验证：

1. 创建临时 Git fixture；
2. 创建 Claude Agent sandbox；
3. Agent 修改候选文件；
4. 宿主收集候选字节；
5. 创建独立 Gate sandbox；
6. Gate 执行 command contract；
7. 宿主分类 pass；
8. 发布精确候选；
9. 清理 Agent 和 Gate sandbox。

## 真实 CLI 默认持久化路径

验证方式：

1. 创建临时项目 `/tmp/harness-daytona-cli-volume-xOSqtX`；
2. 不设置 `HARNESS_DAYTONA_OBSERVABILITY=0`；
3. 运行 `node dist/src/cli.js run ... --driver claude --dir contracts --max-attempts 1`；
4. 校验 `.harness/runs/<runId>.json`。

关键结果：

```text
agent.observability.start claudeConfigDir=/harness-observability/attempt-1/.claude
agent.observability.end outcome=ready
agent.command.end exitCode=0
gate.run.end outcome=pass
运行记录: /private/tmp/harness-daytona-cli-volume-xOSqtX/.harness/runs/2026-06-17T02-17-03-125Z-2180e022.json
```

run manifest 校验结果：

```json
{
  "status": "completed",
  "outcome": "ready_for_mr",
  "runRoot": "/harness-observability/runs/2026-06-17T02-17-03-125Z-2180e022",
  "claudeConfigDir": "/harness-observability/attempt-1/.claude",
  "observabilitySetup": {
    "outcome": "ready"
  }
}
```

## 复挂 Volume 读取 `.claude`

验证方式：

1. 读取成功 CLI run 的 `runId`；
2. 创建新的临时 Agent sandbox；
3. 复挂 volume `harness-claude-observability`，subpath 为 `runs/<runId>`；
4. 通过 Daytona 原生 FS API 使用绝对路径列出 `/harness-observability`。

确认路径：

```text
/harness-observability/attempt-1/.claude/.claude.json
/harness-observability/attempt-1/.claude/.last-cleanup
/harness-observability/attempt-1/.claude/backups
/harness-observability/attempt-1/.claude/projects
/harness-observability/attempt-1/.claude/projects/-home-daytona-workspace-candidate/e322c472-e2c4-441d-b129-f106b04b616b.jsonl
/harness-observability/attempt-1/.claude/sessions
```

会话文件开头包含 queue operation、user prompt、cwd、session id 等 Claude Code
会话记录。该文件在原 Agent sandbox 删除后仍可通过同一 volume/subpath 复挂读取。

## 404 诊断结论

诊断时曾遇到 Daytona FS API `404`。根因不是 volume 被 sandbox 独占，而是
Harness adapter 的 workspace 读取逻辑会把绝对 path 裁成相对 path：

```text
/harness-observability -> harness-observability
```

对 mounted volume path，Daytona 原生 FS API 需要绝对路径：

```text
listFiles("harness-observability")           -> 404
listFiles("/harness-observability")          -> OK
listFiles("harness-observability/attempt-1") -> 404
listFiles("/harness-observability/attempt-1")-> OK
```

该问题只影响后续如果要在 Harness 中内置 artifact viewer 的读取实现，不影响本轮
run-time persistence。

## Daytona Runner Volume 前置条件

默认持久化路径依赖 Daytona runner 支持 S3/FUSE volume mount。部署侧已经修复：

- runner 镜像为 `daytona-runner-mount-s3:local`；
- `mount-s3 --version` 返回 `mount-s3 1.22.3`；
- `/dev/fuse`、`fusermount` 和 `user_allow_other` 可用；
- wrapper 为 MinIO/S3-compatible endpoint 补 `--force-path-style`；
- 使用真实 `daytona-volume-<uuid>` bucket 做 mount/write/read/delete/unmount
  smoke test 通过。

## 工作区状态

验证结束后 feature worktree 干净：

```text
git status --short
# no output
```

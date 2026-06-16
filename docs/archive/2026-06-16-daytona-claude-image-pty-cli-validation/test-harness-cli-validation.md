# `test_harness` CLI 实测记录

目标项目：

```text
/Users/zhongyy40/workspace/test_harness
```

目标 CLI：

```text
/Users/zhongyy40/workspace/harnesscli/harness/.worktrees/daytona-claude-image-setup/dist/src/cli.js
```

## 运行命令

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-$ANTHROPIC_API_KEY}"
node /Users/zhongyy40/workspace/harnesscli/harness/.worktrees/daytona-claude-image-setup/dist/src/cli.js \
  run \
  --driver claude \
  --dir contracts \
  "按 docs/plans/file-server-build.md 实现文件上传服务器"
```

## 运行结果

```text
exit: 1
driver: daytona(claude)
outcome: escalated
attempts: 3
summary: pass 1 / fail 0 / error 5 / total 6
action.kind: human_review_contract
action.checkId: download.not-found
```

Run record：

```text
/Users/zhongyy40/workspace/test_harness/.harness/runs/2026-06-16T02-09-58-593Z.json
```

远端 sandbox 清理：

```json
{"count":0,"ids":[]}
```

## 实测前后工作区状态

运行前 `test_harness` 已经是 dirty：

```text
 M package.json
?? src/
```

运行后仍是：

```text
 M package.json
?? src/
```

Agent 产出包括：

```text
src/server.js
src/handler/download.js
src/handler/files.js
src/handler/health.js
src/handler/upload.js
```

`package.json` 移除了 `express` 和 `multer` 依赖，当前实现使用 Node.js 原生
`http` 和文件系统 API。

## 复核结论

CLI 的 Daytona 链路有效：

- Agent sandbox 创建成功；
- r2 Snapshot 可用于 Claude Agent；
- workspace 上传和 preflight 成功；
- Claude command 执行成功；
- Gate sandbox 创建、执行、清理链路跑通；
- 结束后远端 sandbox 数量为 0。

但 `test_harness` 业务门禁没有通过。根因不是 Daytona 残留或 Agent/Gate 创建
失败，而是目标项目门禁配置不完整：

```json
"gateSetup": []
```

同时 5 个 HTTP contracts 都访问：

```text
http://127.0.0.1:3000
```

远端 Gate sandbox 中没有启动文件服务器，所以 HTTP 契约在远端 gate 中为
error，只有 `smoke.boot` 这类本地命令契约能通过。

## 本地对照

本机存在宿主进程监听 `:3000`：

```text
node PID 23460 TCP *:3000 LISTEN
```

因此本地 `harness check --dir contracts --json` 会打到宿主服务，不代表隔离
Gate 结果。对照结果为：

```text
pass 5 / fail 1 / error 0
```

唯一 fail 是 `files.list`：

```text
期望 files=[] count=0
实际 uploads 中已有 .gitkeep 和 hello.txt
```

## 下一步建议

若要让 `test_harness` 在远端 Gate sandbox 中通过，应修改目标项目自己的配置：

1. 在 `gateSetup` 中启动服务，例如 `npm start` 后等待 `127.0.0.1:3000/health`；
2. 明确 `uploads` 的初始状态，避免 `files.list` 与 `upload.file` 的状态顺序冲突；
3. 将 `docs/plans/file-server-build.md` 加入 agent 可见输入，或把任务描述改成
   不依赖不可见文件内容。

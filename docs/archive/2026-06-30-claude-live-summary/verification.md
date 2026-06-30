# Verification

## Red-Green Regression

新增测试：

```bash
node --test dist/test/cli-redaction.test.js
```

红灯：

```text
test/cli-redaction.test.ts(6,3): error TS2305:
Module '"../src/cli.js"' has no exported member 'renderSandboxObservation'.
```

绿灯：

```text
tests 2
pass 2
fail 0
```

覆盖重点：

- Claude text event 渲染成 `Claude: ...`；
- Claude tool event 渲染工具名和安全字段；
- command progress event 渲染 event/tool/parsed bytes；
- Claude result event 渲染 session、turns 和耗时；
- 既有 redaction 测试继续通过。

## Targeted Suite

命令：

```bash
npm run build
node --test dist/test/cli-redaction.test.js dist/test/cli-run-record.test.js dist/test/frozen-contract-callers.test.js dist/test/daytona-environment.test.js
```

结果：

```text
targeted tests 50
pass 50
fail 0
```

## Full Suite

命令：

```bash
npm test
```

说明：全量测试需要在 `127.0.0.1` 启动测试服务，因此在无 sandbox 权限下运行。

结果：

```text
tests 602
pass 602
fail 0
exit 0
```

## Real Harness Run

临时 fixture：

```text
/private/tmp/harness-live-summary.U1s45A
```

本地 gate 预检：

```bash
node dist/src/cli.js contract validate contracts
node dist/src/cli.js check --dir contracts --config harness.config.json --json
```

结果：

```text
contract validate exit 0
check outcome fail
summary pass 0, fail 1, error 0, total 1
```

真实运行命令：

```bash
node /Users/zhongyy40/workspace/harnesscli/harness/.worktrees/claude-live-summary/dist/src/cli.js \
  run "Change src/result.txt to exactly passed. Keep scope minimal; only edit src/result.txt." \
  --driver claude \
  --dir contracts \
  --config harness.config.json \
  --max-attempts 1
```

初次 sandboxed run 被本机 Daytona API 连接权限拦截：

```text
connect EPERM 127.0.0.1:7897
```

无 sandbox 重跑后，终端在 `agent.command.end` 前打印 Claude live summaries：

```text
Claude progress: system · 1275 bytes parsed
Claude progress: assistant · 1732 bytes parsed
Claude tool: Read path="/home/daytona/workspace/candidate/src/result.txt"
Claude tool: Write path="/home/daytona/workspace/candidate/src/result.txt"
Claude: Done. src/result.txt now contains exactly `passed`.
Claude result: session=61776d7b-9899-438e-822a-9fed1a3c88b3 · turns=3 · durationMs=9371 · durationApiMs=11606 · ttftMs=2916
```

RunStore confirmed the same `agent.claude.*` and `agent.command.progress`
events before `agent.command.end`.

Residual issue in the fixture run:

```text
harness.candidate-integrity error:
Client network socket disconnected before secure TLS connection was established
```

That issue happened after Claude command completion and does not affect the live-summary
verification.

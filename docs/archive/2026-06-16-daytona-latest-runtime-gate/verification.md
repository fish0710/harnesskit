# Verification

## Unit And Integration Tests

```bash
npm run check
```

结果：

```text
tests 249
pass 249
fail 0
```

## Formatting Guard

```bash
git diff --check
```

结果：无输出，退出码 0。

## Remote Daytona Snapshots

```text
harness-agent-claude-latest   active
harness-gate-runtime-latest   active
```

创建命令：

```bash
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:agent
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:gate
```

## Real Gate Run

命令在 `/Users/zhongyy40/workspace/test_harness` 执行：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="daytona.wieimmer.asia,localhost,127.0.0.1,proxy.localhost,.localhost"

node /Users/zhongyy40/workspace/harnesscli/harness/.worktrees/daytona-claude-image-setup/dist/src/cli.js \
  run \
  --driver command \
  --agent-cmd "true" \
  --dir contracts \
  --max-attempts 1 \
  "验证当前候选文件服务器门禁"
```

结果：

```text
environment=daytona(command)
gate.network.end: blocked=false, reason=loopback-http
gate.run.end: outcome=pass, results=6
门禁: pass(pass 6/6, fail 0, error 0, review 0)
```

## Root Causes Closed

1. Gate 默认 runtime 缺 `/usr/bin/bash`，导致 Daytona `executeCommand` 无法执行
   HTTP evidence 脚本。
2. Gate 需要 loopback HTTP 时不能启用 Daytona `networkBlockAll`，否则会阻断
   `127.0.0.1` 服务验证。
3. bash locale warning 会写入 stdout，必须用 marker 定位可信 HTTP evidence
   JSON，而不是解析整个 stdout。
4. 本机 7897 代理关闭时，远端 Daytona SDK 调用必须清理代理变量。

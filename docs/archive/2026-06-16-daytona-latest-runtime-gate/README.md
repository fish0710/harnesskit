# Daytona Latest Runtime Gate Archive

归档日期：2026-06-16

## 背景

本轮目标是把 Harness 的 Daytona 执行链路稳定到两个 host-selected runtime
Snapshot：

- Agent sandbox 使用 `harness-agent-claude-latest`；
- Gate sandbox 使用 `harness-gate-runtime-latest`。

这样后续升级只替换 latest Snapshot，业务运行逻辑不再散落具体版本号。

## 当前结论

远端 Daytona 上已存在并验证通过：

```text
harness-agent-claude-latest   active
harness-gate-runtime-latest   active
```

`harness-agent-claude-latest` 从不可变源
`harness-agent-claude-2.1.145-r2` 派生。

`harness-gate-runtime-latest` 也从 r2 派生，但保存前删除 Claude 路径并验证
`command -v claude` 失败。Gate Snapshot 只用于提供 bash、Node.js、npm、npx、
python3 和 curl，不注入模型凭据、Langfuse 凭据或 agent 进程。

## 主要改动

- `HARNESS_DAYTONA_AGENT_SNAPSHOT` 缺省为 `harness-agent-claude-latest`；
- 新增 `HARNESS_DAYTONA_GATE_SNAPSHOT`，缺省为
  `harness-gate-runtime-latest`；
- Daytona provider 允许 gate sandbox 使用 snapshot；
- `createDaytonaRunEnvironment` 每轮 gate 都创建新的 gate sandbox，并使用 gate
  runtime Snapshot；
- `snapshot:agent` 从不可变 r2 派生 agent latest；
- 新增 `snapshot:gate` 和 `snapshot:runtime`；
- HTTP evidence 输出增加 `HARNESS_HTTP_EVIDENCE ` marker，宿主只解析 marker
  后的 JSON，避免 bash locale warning 污染 stdout；
- 文档补齐门禁插件指南、Daytona/Langfuse 观测说明、latest runtime 维护方式。

## 代理处理

本轮确认 7897 代理关闭时，远端 Daytona 调用必须显式清理代理变量：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="daytona.wieimmer.asia,localhost,127.0.0.1,proxy.localhost,.localhost"
```

Node/Daytona SDK 在清理代理变量后可以访问远端 API；保留关闭的
`127.0.0.1:7897` 会导致 TLS tunnel 或 socket hang up 类错误。

## 真实验证

在 `/Users/zhongyy40/workspace/test_harness` 运行真实远端 Daytona gate：

```bash
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
门禁: pass(pass 6/6, fail 0, error 0, review 0)
```

运行记录：

```text
/Users/zhongyy40/workspace/test_harness/.harness/runs/2026-06-16T03-39-38-081Z.json
```

## 后续维护

替换 latest：

```bash
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:runtime
```

发布新的不可变版本时，先创建例如 `harness-agent-claude-<version>-r3`，验证后再从
该源替换两个 latest Snapshot。

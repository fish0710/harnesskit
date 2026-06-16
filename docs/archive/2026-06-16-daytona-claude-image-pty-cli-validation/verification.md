# 验证记录

## 本地自动化测试

验证命令：

```bash
npm run check
```

2026-06-16 当前结果：

```text
tests 241
pass 241
fail 0
cancelled 0
skipped 0
todo 0
```

新增覆盖：

- Agent image release 固定为 `2.1.145-r2`；
- Claude toolchain preflight 要求 `/usr/bin/bash`；
- 缺少 bash 的 Agent image 会被 preflight 拒绝；
- fake Daytona environment fixture 同步覆盖 bash 输出；
- `test:daytona:pty` 作为真实远端 PTY integration 入口。

## 本地 Docker 镜像构建

验证命令：

```bash
docker build --pull=false \
  -t harness-daytona-claude:pty-bash-test \
  images/daytona/claude
```

结果：

```text
DONE
harness-daytona-claude:pty-bash-test
```

构建阶段验证：

```text
test -x /usr/bin/bash
node --version == v22.14.0
claude --version == 2.1.145
```

## 远端 Snapshot 构建与激活

验证命令：

```bash
npm run snapshot:agent
```

结果：

```text
registry:6000/harness/harness-daytona-claude:2.1.145-r2
digest: sha256:6d3cea7e72841d9b6b97c2a1235d12ab2ccfe1992884811e538694b12b192612
export HARNESS_DAYTONA_AGENT_SNAPSHOT=harness-agent-claude-2.1.145-r2
```

说明：

- 首次创建 r2 Snapshot 时 Daytona API 曾在 building 阶段返回 `ECONNRESET`；
- 查询确认 Snapshot 已存在且从 `building` 进入 `active`；
- 重新运行 `npm run snapshot:agent` 后通过脚本自己的构建、推送、兼容检查和
  临时 sandbox preflight。

## 远端 Agent/Gate 集成

验证命令：

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
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
2. 创建 Agent sandbox；
3. 使用 r2 Snapshot 启动 Claude Code；
4. Agent 修改候选文件；
5. 宿主收集候选字节；
6. 创建独立 Gate sandbox；
7. Gate 执行命令契约并返回 raw evidence；
8. 宿主分类 pass；
9. 发布精确候选；
10. 清理 Agent 和 Gate sandbox。

## 远端 PTY 集成

验证命令：

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
npm run test:daytona:pty
```

结果：

```text
PASS Daytona PTY integration
```

该测试实际验证：

1. 创建 r2 Agent sandbox；
2. 创建 harness 使用的 `/workspace` 目录；
3. 通过 SDK `createPty/connect` 连接公网 `/toolbox/<sandbox>`；
4. 执行 `printf pty-ok`；
5. 验证 exit code 为 0 且输出包含 sentinel；
6. 删除 sandbox。

## 清理验证

验证命令通过 Daytona SDK `list()` 查询：

```json
{"count":0,"ids":[]}
```

说明最终验证结束后没有远端 sandbox 残留。

## 凭证处理

- Daytona API key 仅从 shell 环境读取；
- 模型 token 仅通过运行进程环境注入；
- 归档不保存真实 key 或 token；
- 命令记录只保留变量名和 Snapshot 名称。

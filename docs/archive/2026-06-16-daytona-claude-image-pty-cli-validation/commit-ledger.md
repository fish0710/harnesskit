# 提交账本

提交范围：`main..codex/daytona-claude-image-setup`

| 提交 | 内容 |
|---|---|
| `308732f` | 选择 pinned Daytona Agent Snapshot |
| `2cb66ba` | Claude runs 要求显式 Daytona Agent Snapshot |
| `e6aefa4` | 阻止 Gate sandbox 使用 Agent Snapshot |
| `2deef76` | 加固 run 阶段不安装 Claude 的测试覆盖 |
| `2846ae5` | sandbox setup 改用 HTTP execute，不依赖 PTY |
| `3f5ed68` | manager 透传配置的 Snapshot |
| `76c4aa0` | PTY 命令显式结束，避免等待卡死 |
| `a7d89f6` | Daytona observation 脱敏 |
| `c479873` | 构建 pinned Daytona Claude Snapshot |
| `fe72ee4` | 覆盖 Daytona Agent setup integration |
| `4af2d4d` | 增加 Daytona Claude Snapshot 操作文档 |
| `3b4b610` | 支持 Snapshot build diagnostics |
| `0856e2d` | 支持远端 Daytona toolbox execution |
| `5caa154` | 保持 PTY 使用公网 toolbox proxy |
| `0b72601` | 验证 Daytona PTY Snapshot runtime |

## 变更规模

相对 `main`：

- 19 个文件发生变化；
- 新增约 1,869 行；
- 删除约 90 行；
- 新增 Claude Agent Snapshot 构建工具、toolchain preflight、远端 PTY
  integration、远端 toolbox URL 兼容逻辑，以及运行手册更新。

## 关键代码边界

```text
images/daytona/claude/Dockerfile
src/harness/sandbox/toolchain.ts
src/tools/daytona-agent-snapshot.ts
src/harness/sandbox/daytona.ts
src/harness/sandbox/environment.ts
test/daytona-pty.ts
```

## 关键修复链

### Snapshot 选择

宿主必须配置 `HARNESS_DAYTONA_AGENT_SNAPSHOT`。Claude Agent sandbox 使用该
Snapshot，Gate sandbox 永远不接收 Snapshot。

### Run 阶段去安装

Claude Code 不在 run 阶段安装，避免远端下载、PTY shell、代理和超时问题影响
主流程。

### Remote Toolbox

远端 API 场景下，REST generated client 需要使用
`/api/toolbox/<sandbox>/toolbox`，但 PTY SDK base 必须保持
`/toolbox/<sandbox>`。两者分离后，HTTP execute 和 PTY WebSocket 都可用。

### PTY Runtime

r2 Snapshot 显式校验 `/usr/bin/bash`，并通过真实远端 PTY integration 证明 SDK
PTY 可以连接、执行命令并返回 sentinel 输出。

### CLI 实测

`test_harness` 实测证明 CLI 进入 Daytona Agent/Gate 链路，并在结束后清理远端
sandbox。失败停在目标项目门禁契约配置，而非 harness/Daytona 链路。

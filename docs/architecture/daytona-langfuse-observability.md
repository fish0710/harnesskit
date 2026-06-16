# Daytona Claude 与 Langfuse 观测边界

> 状态：当前设计说明
>
> 更新日期：2026-06-16
>
> 适用范围：`harness run --driver claude`、Daytona Agent Snapshot、
> Langfuse/OpenTelemetry 观测

## 1. 当前 host 侧为什么能 trace

host 本地 Claude driver 走的是 Claude Agent SDK：

1. `claudeDriver()` 动态加载 `@anthropic-ai/claude-agent-sdk`。
2. 如果宿主进程环境存在 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`，
   `startLangfuseObservability()` 会启动 OpenTelemetry Node SDK。
3. 该函数创建 `ClaudeAgentSDKInstrumentation`。
4. instrumentation 对 SDK 模块执行 `manuallyInstrument()`。
5. driver 调用被包裹后的 `claudeSdk.query()`。
6. Claude Agent SDK 产生的 span 被 `LangfuseSpanProcessor` 导出。

关键点：Langfuse trace 不是 Claude CLI 自动产生的，而是 host Node 进程里
OpenTelemetry instrumentation 包住了 Claude Agent SDK 的 `query()`。

因此，仅仅有 `LANGFUSE_*` 环境变量还不够；还必须有一个已启动的
OpenTelemetry SDK，并且被调用的 Claude SDK 已被 instrumentation 包裹。

## 2. Daytona 路径为什么没有 trace

Daytona Claude 路径不是调用 host 的 `claudeSdk.query()`。当前流程是：

1. host 创建 agent 沙箱。
2. host 只把 Anthropic 模型相关变量传给 agent 命令。
3. host 通过 Daytona `executeCommand` 在沙箱内运行 `/usr/local/bin/claude`。
4. Claude Code CLI 在沙箱进程中执行任务。
5. host 只看到该命令的退出码、stdout、stderr 和耗时。

这个路径绕过了 host 侧 Claude Agent SDK driver，所以 host 侧 Langfuse
instrumentation 没有机会包裹沙箱内的 Claude CLI。

同时，当前环境变量白名单不包含 `LANGFUSE_*`。这是刻意的最小泄露策略：

- agent 沙箱只接收模型调用所需变量；
- gate 沙箱不接收模型凭证，也不接收 Langfuse 凭证；
- 宿主密钥不默认暴露给不可信代码。

## 3. 为什么会提到 Node wrapper

Node wrapper 的目的不是“为了启动 Claude”，而是为了在沙箱内复现 host
侧的观测机制。

如果要在沙箱内得到 Claude Agent SDK 级别 trace，需要在沙箱进程内完成和
host 一样的事情：

1. 启动 OpenTelemetry Node SDK。
2. 创建 Langfuse span processor。
3. 加载 Claude Agent SDK。
4. 对 SDK 执行 `ClaudeAgentSDKInstrumentation.manuallyInstrument()`。
5. 调用被包裹后的 `claudeSdk.query()`。

这通常需要一个 Node wrapper，因为当前 `/usr/local/bin/claude` 是 Claude Code
CLI，不是由 Harness 代码直接调用的 SDK 对象。host 侧能 trace 的本质是
“Node 进程里包住 SDK 调用”，不是“shell 环境里有 Langfuse key”。

## 4. r3 快照内置 Langfuse 环境变量能不能做

不建议把 Langfuse 环境变量静默固化进 r3 Snapshot。

原因：

1. Snapshot 是镜像/运行时能力，不应携带可轮换密钥。
2. agent 进程是不可信执行域，能读取自己的环境变量。
3. 静默注入会让所有任务默认外发观测数据，违反最小惊讶和最小泄露。
4. Langfuse secret 泄露后可被 agent 代码读取、打印、写入文件或发送到外部。
5. gate 沙箱更不能带这类观测密钥，因为 gate 应保持无 agent、无模型、无额外凭证。

可以做的是 r3 Snapshot 内置“能力”，不内置“密钥”：

- 预装 `@langfuse/otel`、OpenTelemetry 和 Claude Agent SDK wrapper 依赖；
- 提供 `/usr/local/bin/harness-claude-sdk-wrapper`；
- 运行时由 host 显式选择是否传入 scoped `LANGFUSE_*`；
- 默认不传；
- gate 永不传。

## 5. 能否只同步 Langfuse 环境变量

只同步 `LANGFUSE_*` 到沙箱通常不足以产生 SDK trace。

可能出现三种情况：

| 情况 | 结果 |
|---|---|
| 只传 `LANGFUSE_*`，仍运行 Claude Code CLI | 大概率没有 SDK span，因为没有 instrumentation 包裹 SDK |
| Claude CLI 自身支持某种 OTEL exporter | 可能产生 CLI 自己定义的 span，但这取决于 Claude CLI 能力，不能由 Harness 当前代码保证 |
| 运行 Harness Node wrapper 调 Claude Agent SDK | 可以复现 host 侧 trace 模型，但 agent 沙箱会持有 Langfuse secret |

所以“同步环境变量”不是可靠方案；“同步环境变量 + 沙箱内 instrumentation 入口”
才是可控方案。

## 6. 推荐分层方案

### 6.1 MVP：host 侧 loop trace

先在 host 进程中记录 Harness 自己掌控的 span：

- `harness.run`
- `agent.create`
- `agent.upload`
- `agent.preflight`
- `agent.command`
- `candidate.collect`
- `gate.create`
- `gate.upload`
- `gate.setup`
- `gate.network`
- `gate.run`
- `gate.cleanup`
- `publish`
- `escalation`

优点：

- 不把 Langfuse secret 暴露给 agent；
- 能看清 agent -> gate loop；
- 能定位 gate setup、HTTP 服务启动、沙箱生命周期和升级原因；
- 不改变 Claude 执行方式。

缺点：

- 看不到 Claude 内部 token、tool 和模型 span。

### 6.2 可选：agent 沙箱 SDK wrapper trace

当确实需要 Claude 内部 trace 时，再启用：

- r3 Snapshot 预装 wrapper 和依赖；
- host 增加显式开关，例如 `HARNESS_DAYTONA_AGENT_LANGFUSE=1`；
- 只把 scoped、低权限、可轮换的 Langfuse key 注入 agent 命令 env；
- agent 命令改为运行 wrapper，而不是直接运行 Claude CLI；
- trace metadata 中标记 sandbox id、attempt、task hash，不直接写敏感 prompt。

风险：

- agent 可读取 Langfuse key；
- trace 可能包含源码、prompt、工具输入输出；
- 需要额外脱敏策略和密钥轮换策略。

### 6.3 禁止：gate 沙箱 Langfuse 注入

gate 沙箱不应注入 Langfuse：

- gate 不需要模型观测；
- gate 的职责是纯机器验证和原始证据采集；
- 多一份外部凭证就是多一个被候选代码读取的面；
- gate 结果应由宿主记录，而不是由沙箱内观测上报决定。

## 7. 对 r3 Snapshot 的建议

r3 可以包含：

- Node.js pinned 版本；
- Claude Code pinned 版本；
- bash、npm、npx；
- 可选的 Harness Claude SDK wrapper 文件；
- wrapper 所需 npm 依赖；
- wrapper preflight 检查。

r3 不应包含：

- `LANGFUSE_SECRET_KEY`；
- `LANGFUSE_PUBLIC_KEY`；
- `LANGFUSE_BASE_URL` 的强制默认；
- Daytona API key；
- Anthropic token；
- gate 签名或裁决相关密钥。

运行时如果启用沙箱内 trace，应由 host 显式传入：

```bash
export HARNESS_DAYTONA_AGENT_LANGFUSE=1
export LANGFUSE_PUBLIC_KEY=...
export LANGFUSE_SECRET_KEY=...
export LANGFUSE_BASE_URL=...
```

然后 Harness 只在 agent command env 中传入这些变量，不写入 Snapshot，不写入
项目文件，不传给 gate。

## 8. 当前建议

当前最小 loop 的优先级应是：

1. 修正 gate setup 时序，让真实 HTTP 服务能在 gate 沙箱中启动。
2. 用 `test_harness` 验证 agent -> gate loop。
3. 增加 host 侧 Harness loop Langfuse span。
4. 再评估是否需要 r3 的 SDK wrapper trace。

这样可以先证明“门禁闭环可信”，再扩大“Claude 内部可观察性”。否则容易得到
漂亮 trace，但实际 gate 行为仍然没有跑通。

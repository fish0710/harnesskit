# Harness 使用说明书

这份文档按日常操作顺序写。需要深入理解 Daytona 隔离、候选发布和观测细节时，再看
`docs/daytona-local-claude-code-runbook.md` 和
`docs/architecture/daytona-sandbox-gate.md`。

## 0. 先记住这条主线

Harness 分两层：

1. 验证层：`check`、`gate`、`meta`、`explain`、`contract`、`review`、`status`。
2. 产出层：`create`、`plan`、`run`、`fix`。

真实自动开发流程是：

```text
create 初始化项目
-> 写 contracts 和 harness.config.json
-> check/gate 验证门禁可跑
-> run/fix 调 agent 做修改
-> 每轮 agent 后自动跑 gate
-> pass 后只发布 gate 验过的候选文件
-> blocked 时 review 人工裁决
```

`run` 默认是 `scaffold`，只空跑流程，不会生成代码。要真实修改代码，使用
`--driver claude` 或 `--driver command`。

## 1. 在本仓库调试 Harness CLI

第一次拉代码后：

```bash
npm ci
npm run build
npm run check
```

本仓库没有安装全局 `harness` 命令时，直接跑编译后的入口：

```bash
node dist/src/cli.js help
node dist/src/cli.js status --dir examples/contracts
node dist/src/cli.js check --dir examples/contracts --config examples/harness.config.json
```

如果已经通过 npm/link 安装了 bin，后续命令里的：

```bash
node dist/src/cli.js
```

可以替换成：

```bash
harness
```

## 2. 初始化一个目标项目

在目标项目根目录执行：

```bash
harness create .
```

如果还在本仓库内用未安装版本调试：

```bash
node /Users/zhongyy40/workspace/harnesscli/harness/dist/src/cli.js create .
```

它会生成：

```text
AGENTS.md
harness.config.json
contracts/
docs/
CODEOWNERS
.github/workflows/harness-gate.yml
.harness/
```

已有文件默认不覆盖。确实要重新写模板时再用：

```bash
harness create . --force
```

初始化后先改两类文件：

- `contracts/*.yaml`：定义什么叫通过。
- `harness.config.json`：定义改哪些文件时跑哪些契约，以及 agent 能改哪些候选文件。

## 3. 配置门禁选择和沙箱边界

`harness.config.json` 里常用字段：

```json
{
  "baseline": ["smoke.boot"],
  "rules": [
    { "when": ["src/**"], "select": ["cli.help-exits-zero"] }
  ],
  "sandbox": {
    "candidateRoots": ["src", "test/generated", "package.json", "package-lock.json", "tsconfig.json"],
    "protectedPaths": ["contracts", ".harness", "harness.config.json", ".github/workflows", "CODEOWNERS", "test/gates"],
    "agentSetup": [],
    "gateSetup": [],
    "limits": {
      "maxFiles": 10000,
      "maxFileBytes": 10485760,
      "maxTotalBytes": 209715200
    },
    "retainOnFailure": false
  }
}
```

关键含义：

- `baseline`：默认必跑的契约。
- `rules`：按 changed files 额外选择契约。
- `candidateRoots`：agent 产出的文件必须落在这些路径下。
- `protectedPaths`：即使落在候选根里，也不能被 agent 覆盖。
- `agentSetup`：agent 沙箱启动后先跑的命令，例如 `npm ci`。
- `gateSetup`：gate 沙箱组装候选后先跑的命令，例如启动测试服务。

如果所有候选根都被保护，Harness 会直接报错，因为 agent 没有可发布区域。

## 4. 只跑验证，不启动 agent

校验契约格式：

```bash
harness contract validate contracts
```

冻结单个契约：

```bash
harness contract freeze contracts/smoke.boot.yaml
```

跑全部契约：

```bash
harness check --dir contracts
```

按阶段跑：

```bash
harness gate premerge --dir contracts
```

按改动选择契约：

```bash
harness check --dir contracts --config harness.config.json --changed src/foo.ts,package.json
```

HTTP 契约需要统一 base URL 时：

```bash
harness check --dir contracts --base-url http://127.0.0.1:3000
```

机器可读输出：

```bash
harness check --dir contracts --json
```

解释某条契约：

```bash
harness explain smoke.boot --dir contracts
```

看项目状态，不实际跑门禁：

```bash
harness status --dir contracts
```

退出码约定：

```text
0 = pass / ready
1 = fail / error / escalated
2 = blocked，需要人工 review
```

## 5. 人工裁决 blocked 契约

有些契约会返回 `needs_review`。这时自动循环会停下，先查看待裁决项：

```bash
harness review --dir contracts
```

记录裁决：

```bash
harness review --resolve <contractId> --option <optionId> --by <name> --reason "原因"
```

裁决会写入 `.harness` 下的运行状态。之后重新跑：

```bash
harness check --dir contracts
```

或继续：

```bash
harness run "继续完成任务" --driver claude
```

## 6. 生成计划

对复杂任务先生成计划模板：

```bash
harness plan "实现订单查询接口"
```

它会写入 `docs/plans/`。计划是意图层产物，不等于验收标准；验收仍然要落到
`contracts/`。

## 7. 空跑产出循环

先确认链路能走通，但不让 agent 改文件：

```bash
harness run "实现一个健康检查接口"
```

这等价于：

```bash
harness run "实现一个健康检查接口" --driver scaffold
```

`scaffold` 只会跑一轮空 driver，然后执行门禁。它适合检查：

- 契约是否能加载；
- sandbox policy 是否合法；
- gate 是否能产生诊断；
- run record 是否能写入。

## 8. 用自定义 agent 命令跑

如果你有自己的 agent 脚本：

```bash
harness run "实现一个健康检查接口" \
  --driver command \
  --agent-cmd "./tools/my-agent.sh"
```

Harness 会把任务和上轮门禁反馈放进环境变量：

```text
HARNESS_TASK
HARNESS_FEEDBACK
```

`--driver command` 和 `--driver claude` 都走 Daytona 隔离环境，不会静默退回宿主机执行。

## 9. 用 Daytona + Claude 跑真实自动开发

先准备环境变量。不要把这些值写进仓库：

```bash
export DAYTONA_API_KEY="<daytona-key>"
export DAYTONA_API_URL="http://localhost:3000/api"

export ANTHROPIC_AUTH_TOKEN="<short-lived-model-token>"
export ANTHROPIC_BASE_URL="<approved-model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"
# Optional overrides. If omitted, Harness uses SONNET for ANTHROPIC_MODEL
# and OPUS for ANTHROPIC_REASONING_MODEL.
export ANTHROPIC_MODEL="<model>"
export ANTHROPIC_REASONING_MODEL="<model>"
```

Snapshot 默认值通常不用手动设：

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-latest"
export HARNESS_DAYTONA_GATE_SNAPSHOT="harness-gate-runtime-latest"
```

如果本地代理影响 Daytona，先清理或补充绕过：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="localhost,127.0.0.1,proxy.localhost,.localhost"
```

跑真实任务：

```bash
harness run "实现一个健康检查接口" --driver claude --max-attempts 3
```

限制只跑某个 stage：

```bash
harness run "修复 premerge 门禁" --driver claude --stage premerge --max-attempts 3
```

失败后让 agent 根据当前门禁诊断继续修：

```bash
harness fix --driver claude --max-attempts 3
```

每次 Claude run 会写运行记录：

```text
.harness/runs/<runId>.json
```

默认还会把 Claude Code 的 `.claude` artifact 放进 Daytona volume：

```text
volume: harness-claude-observability
mount: /harness-observability
```

`gate` 沙箱不会拿到模型凭证，也不会复用 agent 沙箱。

## 9A. 串行执行大型任务

不传位置参数时，`harness run` 会从 `harness.config.json` 读取 `tasks`
并按顺序执行。显式传任务仍是单任务模式：

```bash
harness run "实现一个健康检查接口" --driver claude --max-attempts 3
```

串行任务配置示例：

```json
{
  "series": { "id": "order-refactor" },
  "taskDefaults": {
    "gate": {
      "contracts": ["smoke.boot"],
      "stage": "premerge"
    }
  },
  "autoCommit": {
    "enabled": true,
    "messageTemplate": "harness: task {index}/{total} {id}"
  },
  "tasks": [
    {
      "id": "extract-domain-model",
      "task": "Extract the order domain model without changing API behavior.",
      "gate": {
        "contracts": ["domain.model-boundary"]
      }
    },
    {
      "id": "split-order-service",
      "task": "Split order service responsibilities and keep smoke behavior green.",
      "gate": {
        "stage": "service-refactor",
        "contracts": ["service.smoke"]
      }
    }
  ]
}
```

运行整个序列：

```bash
harness run --driver claude --max-attempts 3
```

每个配置任务都会单独调用一次 `runSingleTask`，也就是单独跑一次 agent
任务。对 Daytona/Claude 来说，每个配置任务都会得到新的 Agent sandbox
和新的 Claude task；同一个任务内部仍保留正常 `runLoop` 的门禁反馈、
retry 和 resume 行为。

门禁选择从 `taskDefaults.gate` 开始，再合并每个任务自己的 `gate`。
任务级 `gate` 可以指定 `contracts`、`stage`，也可以同时指定两者：
`contracts` 会追加到默认契约列表，`stage` 会覆盖默认 stage。

串行模式下 `autoCommit.enabled` 默认是 `true`。任务门禁通过并发布文件后，
Harness 只会 stage/commit 本次发布的非 `.harness` 文件；`.harness/runs`
运行记录和 `.harness/series` 进度 ledger 不会被提交。进度 ledger 写在：

```text
.harness/series/<series-id>.json
```

恢复规则：

- `completed` 且 task hash 匹配：跳过。
- `ready_to_commit` 且 task hash 匹配：完成或确认 commit，然后标记
  `completed`。
- `pending` / `running`：重新运行该任务。
- `blocked` / `escalated` / `error`：停止，等待人工处理；不会自动重跑这些
  终态非成功任务。
- `completed` 或 `ready_to_commit` 任务的配置或 hash 漂移：停止，要求恢复配置或使用
  新的 task id。
- 开始新的 agent 工作前发现含义不清的 dirty worktree：停止。
- 如果 commit 已成功，但后续 clean 检查失败，`ready_to_commit` ledger
  可能已经带有 commit SHA；清理工作区后再次运行可以完成标记。

## 10. 维护 Daytona Runtime Snapshot

正常使用不需要每天跑。只有镜像、Claude Code 版本或 runtime 依赖变化时才维护：

```bash
npm run snapshot:agent
npm run snapshot:gate
npm run snapshot:runtime
```

替换已有 latest Snapshot：

```bash
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:runtime
```

集成验证：

```bash
npm run test:daytona
npm run test:daytona:pty
```

这些命令需要真实 Daytona 服务和有效凭证。普通单元测试只需要：

```bash
npm run check
```

## 11. 小程序门禁

`type: miniprogram` 是 host-local gate：agent 仍在 Daytona 沙箱里工作，但小程序
runner 在宿主临时目录执行，用于连接本机微信开发者工具。

契约示例：

```yaml
id: mp.smoke
type: miniprogram
scenario: 小程序首页应能打开并响应点击
projectPath: dist/dev/mp-weixin
runner: test/gates/miniprogram-smoke-runner.js
devtools:
  mode: managed
  cliPath: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
  autoPort: 9420
  trustProject: true
timeoutMs: 120000
expectExit: 0
```

模板在：

```text
examples/miniprogram/
```

## 12. 常见卡点

`harness run` 没有改代码：

```text
原因：默认 driver 是 scaffold。
处理：加 --driver claude 或 --driver command。
```

`--driver command` 报缺少 `--agent-cmd`：

```text
原因：command driver 必须知道要启动哪个脚本。
处理：加 --agent-cmd "./tools/my-agent.sh"。
```

Daytona 相关命令报 `DAYTONA_API_KEY`：

```text
原因：宿主环境没有 Daytona key。
处理：export DAYTONA_API_KEY=...
```

本地 Daytona 或 toolbox 请求出现 502：

```text
原因：proxy.localhost 被 HTTP_PROXY 代理走了。
处理：NO_PROXY/no_proxy 里包含 localhost,127.0.0.1,.localhost,proxy.localhost。
```

gate 通过后没有发布某些文件：

```text
原因：文件不在 candidateRoots 内，或命中了 protectedPaths。
处理：调整 harness.config.json，但 contracts/.harness/CI 这类裁决资产不应开放给 agent。
```

HTTP 契约访问不到服务：

```text
原因：gate 沙箱里没有启动服务，或 base URL 指错。
处理：在 gateSetup 启动服务，或使用 --base-url 指向正确地址。
```

`blocked` 后自动循环停止：

```text
原因：这是人工裁决边界，不应自动猜。
处理：harness review 查看并记录 verdict，然后重跑。
```

## 13. 最短可复制流程

本仓库自检：

```bash
npm ci
npm run build
npm run check
```

目标项目接入：

```bash
harness create .
harness contract validate contracts
harness check --dir contracts --config harness.config.json
harness run "实现任务" --driver claude --max-attempts 3
harness status
```

只想安全试流程：

```bash
harness run "实现任务" --driver scaffold
```

有 blocked：

```bash
harness review --dir contracts
harness review --resolve <contractId> --option <optionId> --by <name> --reason "原因"
harness check --dir contracts
```

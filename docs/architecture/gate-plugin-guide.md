# Harness 门禁插件指南

> 状态：当前实现指南
>
> 更新日期：2026-06-16
>
> 适用范围：`harness check`、`harness gate`、`harness run` 中的
> `GateCore` 与 `src/plugins/*`

## 1. 门禁插件是什么

Harness 的门禁不是固定的“输入、命令、输出”三段式，而是一个按
`type` 分发的插件系统：

1. `contracts/*.yaml|json` 声明契约。
2. 每条契约至少包含 `id` 和 `type`。
3. `GateCore` 按 `type` 找到对应插件。
4. 插件执行检查，返回 `CheckResult`。
5. `aggregate()` 把所有结果聚合为 `pass`、`fail` 或 `blocked`。

安全边界是：

> 沙箱只产生原始证据，宿主插件才负责分类为 `pass`、`fail`、`error`
> 或 `needs_review`。

这意味着 gate 沙箱不能返回可信的 `CheckResult`，也不能自行决定通过。
沙箱返回的命令退出码、stdout、stderr、HTTP 状态、响应体和耗时只是证据。

## 2. 契约文件结构

一个契约文件可以包含单条契约，也可以包含契约数组。YAML 和 JSON 都支持。

最小外壳：

```yaml
id: health.endpoint
type: http
scenario: 健康检查接口应返回 200 OK
```

通用字段：

| 字段 | 说明 |
|---|---|
| `id` | 全局唯一检查 ID。用于报告、人工 verdict 和失败反馈 |
| `type` | 插件类型。必须有已注册插件处理 |
| `scenario` | 业务意图说明，用于报告中的 `why` |
| `owner` | 可选负责人 |
| `ref` | 可选参考文档 |
| `frozen` / `hash` | 冻结合约防篡改字段，由 `harness contract freeze` 生成 |

类型专属字段由插件解释。未知 `type` 不在加载阶段报错，而是在运行阶段变成
`error`，避免误当通过。

## 3. 原生插件类型

### command

用途：执行一个命令并按退出码判定。

```yaml
id: smoke.node
type: command
scenario: 项目必须能在 Node.js 运行时执行
cmd: node
args: ["--version"]
expectExit: 0
timeoutMs: 30000
```

语义：

| 情况 | 状态 |
|---|---|
| 命令启动成功且退出码等于 `expectExit` | `pass` |
| 命令启动成功但退出码不符合 | `fail` |
| 命令无法启动、超时、证据缺失或 ID 不匹配 | `error` |

### boot

用途：用命令近似测量启动耗时。适合早期 smoke，但真实服务更推荐用
`gateSetup` 启动服务后用 `http` 契约验证 ready 行为。

```yaml
id: app.boot
type: boot
scenario: 服务应在 800ms 内完成启动检查
cmd: node
args: ["src/server.js", "--check-startup"]
expect:
  startup_ms_lte: 800
```

### http

用途：在当前执行环境里发 HTTP 请求并断言响应。Daytona gate 模式下，
`127.0.0.1` 指 gate 沙箱内部，不是宿主机器。

```yaml
id: health.endpoint
type: http
scenario: 健康检查接口应返回 200 OK
trigger:
  method: GET
  baseUrl: "http://127.0.0.1:3000"
  path: /health
  timeoutMs: 30000
expect:
  status: 200
  body_contains:
    status: ok
```

`expect.body_contains` 可以是 JSON 字段子集，也可以是字符串子串。

注意：HTTP 插件只负责请求与断言，不负责启动服务。服务启动应由 gate
装配阶段完成，例如 `gateSetup`。

Daytona gate 模式要求 gate runtime 至少有 `/usr/bin/bash` 和 Node.js，因为
HTTP evidence 会在 gate 沙箱内运行一段 Node 脚本来发请求并返回原始证据。当前
默认 Snapshot 是 `harness-gate-runtime-latest`，可用
`HARNESS_DAYTONA_GATE_SNAPSHOT` 覆盖。该 Snapshot 不应注入模型密钥，也不应暴露
`claude` 命令。

### structure

用途：调用外部静态分析工具，例如 eslint、import-linter、
dependency-cruiser、SwiftLint。

```yaml
id: lint.eslint
type: structure
scenario: 源码必须通过 eslint
tool: npx
args: ["eslint", "--format", "json", "src"]
parse: eslint-json
expectExit: 0
```

工具不可执行是 `error`，工具执行成功但发现问题是 `fail`。

### invariant

用途：属性测试。契约只引用属性名，属性函数由宿主通过 `--properties`
模块注入。

```yaml
id: normalize.idempotent
type: invariant
scenario: normalize 应满足幂等性
property: normalizeIdempotent
trigger:
  generator: strings
  samples: 200
```

运行：

```bash
harness check --properties ./contracts/properties.js
```

属性不存在是 `error`；找到反例是 `fail`。

### miniprogram

用途：验证微信小程序行为。该插件在宿主执行 runner，由 runner 通过
`miniprogram-automator` 连接微信开发者工具的 WebSocket 自动化端口。

```yaml
id: mp.login
type: miniprogram
scenario: 小程序登录页应能完成手机号授权前置校验
projectPath: dist/dev/mp-weixin
runner: test/gates/miniprogram-login.js
devtools:
  mode: connect
  wsEndpoint: ws://127.0.0.1:9420
timeoutMs: 120000
expectExit: 0
```

字段语义：

| 字段 | 说明 |
|---|---|
| `projectPath` | 必填，工作区内小程序项目目录，必须包含 `project.config.json` |
| `runner` | 必填，工作区内 Node.js runner 文件 |
| `devtools.mode` | `connect` 连接已启动的开发者工具；`managed` 由插件先调用 CLI 启动自动化 |
| `devtools.wsEndpoint` | `connect` 模式下传给 runner 的 WebSocket endpoint |
| `devtools.cliPath` | `managed` 模式下的微信开发者工具 CLI 路径，默认 macOS 安装路径 |
| `devtools.autoPort` | `managed` 模式下的自动化端口，默认 `9420` |
| `devtools.trustProject` | `managed` 模式是否传 `--trust-project`，默认 `true` |
| `timeoutMs` | runner 和 managed CLI 启动的超时时间 |
| `expectExit` | runner 期望退出码，默认 `0` |

runner 启动时只接收插件显式注入的环境变量：

| 环境变量 | 说明 |
|---|---|
| `HARNESS_MINIPROGRAM_PROJECT` | 契约中的相对 `projectPath` |
| `HARNESS_MINIPROGRAM_PROJECT_ABS` | 真实解析后的项目绝对路径 |
| `HARNESS_MINIPROGRAM_WS_ENDPOINT` | 开发者工具 WebSocket endpoint |
| `HARNESS_MINIPROGRAM_DEVTOOLS_PORT` | `managed` 模式的自动化端口 |

安全边界：

- `projectPath` 和 `runner` 必须是工作区相对路径，拒绝绝对路径、Windows drive
  路径、`..` 和 symlink escape。
- 插件使用 realpath 后的项目目录与 runner 文件执行，`project.config.json` 也必须
  位于工作区内。
- runner 不继承宿主 ambient environment。managed DevTools CLI 只接收 `HOME`，
  用于读取微信开发者工具本机配置目录，不透传其它 ambient 变量。
- Daytona `harness run` 中，小程序契约不进入远端 gate 沙箱。宿主会把本轮
  `CandidateSnapshot` materialize 到临时目录，在该目录运行 miniprogram 契约，
  然后删除临时目录。
- remote gate 契约和 host-local 小程序契约的结果会一起聚合；任一失败、错误或清理
  失败都不会发布候选文件。

本地 `harness check` / `harness gate` 直接在当前工作区跑该插件，适合连接本机
微信开发者工具。`harness run --driver claude` 下，agent 仍在 Daytona 沙箱中工作，
但小程序验证留在宿主，避免远端沙箱反连本机 DevTools 的网络穿透问题。

### review

用途：机器无法可靠判定时，把结构化问题交给人。

```yaml
id: product.behavior-change
type: review
scenario: 上传接口返回结构发生变化
question: 这是有意产品变更，还是回归？
focalPoints:
  - 客户端是否依赖旧字段名？
  - 是否已有产品或接口文档批准？
evidence:
  - label: 旧行为
    value: 返回 fileName
  - label: 新行为
    value: 返回 name
options:
  - id: intended
    label: 有意改变，允许更新契约
    resolvesTo: pass
  - id: regression
    label: 判定为回归，挡回修复
    resolvesTo: fail
recommended: regression
```

无人工裁决时返回 `needs_review`，整体门禁为 `blocked`，退出码为 2。

记录裁决：

```bash
harness review --resolve product.behavior-change \
  --option regression \
  --by zhongyy40 \
  --reason "缺少接口变更批准"
```

裁决写入 `.harness/verdicts.json`，下一次检查会把该 review 解析为
`pass` 或 `fail`。

## 4. 人工复审的两个层次

第一层是显式 `review` 契约。它是规则作者预先知道“机器无法判断”的场景，
例如产品行为变化、兼容性取舍、风险接受。

第二层是 run loop 的自动升级。当同一个普通检查连续失败到阈值，Harness 会返回
`human_review_contract`，意思是“可能不是代码修不好，而是契约本身需要人确认”。
这不是自动放行机制，也不会写 verdict。

建议后续为第二层增加 host-only review artifact，让人可以明确选择：

| 选择 | 含义 |
|---|---|
| `fix_required` | 契约有效，继续要求 agent 修 |
| `contract_invalid` | 契约错误，停止 loop 并要求改契约 |
| `accept_risk` | 本次接受风险，记录原因和过期时间 |

这些记录必须由宿主或人工写入，不能由 agent 或 gate 沙箱写入。

## 5. 如何新增一种门禁类型

优先判断是否能用现有类型表达：

- 只是跑命令：用 `command`。
- 只是验证 HTTP 行为：用 `http`。
- 只是静态分析：用 `structure`。
- 只是人工判断：用 `review`。
- 少量属性测试：用 `invariant`。

确实需要新类型时，按以下步骤做：

1. 在 `src/plugins/<type>.ts` 实现 `Plugin`。
2. `plugin.type` 使用全局唯一字符串。
3. `run(contract, ctx)` 返回完整 `CheckResult`。
4. 如果需要执行命令或 HTTP，请通过 `ctx.execution` 获取原始证据。
5. 在宿主侧验证 evidence ID、退出码、耗时、HTTP 状态等合法域。
6. 不要让沙箱返回已经分类好的 `pass/fail`。
7. 在 `src/cli.ts` 的 `buildGate()` 注册插件。
8. 在 `src/contracts.ts` 的 `REQUIRED_BY_TYPE` 登记必填字段。
9. 增加插件单测和 remote execution 单测。
10. 给文档补 YAML 示例。

插件骨架：

```ts
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

export const myPlugin: Plugin = {
  type: "my-type",

  async run(contract: Contract, ctx: RunContext): Promise<CheckResult> {
    // 1. 读取并校验 contract 字段
    // 2. 通过 ctx.execution 收集原始证据，或在宿主侧直接做纯计算
    // 3. 宿主侧分类为 pass/fail/error/needs_review
    return {
      id: contract.id,
      type: this.type,
      status: "pass",
      durationMs: 0,
      violations: [],
    };
  },
};
```

## 6. 新插件的安全检查清单

- 未知或缺失必填字段必须是 `error`。
- 执行目标异常必须是 `error`，不能降级为 `pass`。
- 证据 ID 不匹配必须是 `error`。
- 证据缺少耗时、退出码或 HTTP 状态时必须是 `error`。
- 沙箱 stdout/stderr 只能用于诊断，不能被当成可信判定。
- 插件返回的 `violation` 必须包含可执行的 `what`、`why`、`how`。
- 新插件必须有正例、反例、执行失败和证据不可信测试。
- 若插件会调用外部工具，工具未安装应是 `error`。
- 若插件涉及网络，必须明确是在 host、agent sandbox 还是 gate sandbox 执行。

## 7. HTTP 服务类项目的推荐写法

对于需要启动本地服务的项目，推荐：

1. `agentSetup` 只做 agent 产出前准备，例如安装依赖。
2. `gateSetup` 在 gate 沙箱组装好候选代码后执行。
3. `gateSetup` 启动服务并轮询 ready。
4. HTTP 契约只验证行为，不负责启动服务。

示例：

```json
{
  "sandbox": {
    "candidateRoots": ["src", "uploads", "package.json"],
    "protectedPaths": ["contracts", ".harness", "harness.config.json"],
    "agentSetup": ["npm install"],
    "gateSetup": [
      "rm -rf uploads && mkdir -p uploads",
      "nohup npm start > /tmp/harness-server.log 2>&1 < /dev/null & echo $! > /tmp/harness-server.pid",
      "for i in $(seq 1 50); do node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\" && exit 0; sleep 0.2; done; cat /tmp/harness-server.log; exit 1"
    ]
  }
}
```

HTTP 契约之间不要依赖共享状态。若必须测试上传后列表变化，应让契约明确表达顺序，
或为每个契约增加隔离 setup/teardown 能力。

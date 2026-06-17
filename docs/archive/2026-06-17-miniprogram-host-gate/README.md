# MiniProgram Host Gate Archive

归档日期：2026-06-17

## 背景

本轮目标是新增 Harness 小程序验证契约，让 agent 仍在 Daytona 沙箱中工作，
但微信小程序自动化验证留在宿主机执行，从而直接连接本机 macOS 上的微信开发者工具。

核心问题是：远端 Daytona 沙箱很难稳定反连本机 DevTools WebSocket，而
`miniprogram-automator` 本身支持 `connect({ wsEndpoint })`。因此本轮实现采用
host-local gate：宿主把候选快照 materialize 到临时目录，在该目录运行小程序 runner，
再把结果和远端 gate 结果一起聚合。

## 当前结论

`type: miniprogram` 已成为一等门禁契约：

- 本地 `harness check` / `harness gate` 可直接执行小程序 runner；
- `devtools.mode: managed` 可由插件调用本机微信开发者工具 CLI 启动 automation；
- `devtools.mode: connect` 可连接已启动的 DevTools WebSocket；
- Daytona `harness run` 会把小程序契约拆到宿主临时工作区执行；
- 远端 gate 契约和 host-local 小程序契约共同决定是否发布；
- 小程序失败会反馈回 agent，重复失败会进入 `human_review_contract` 升级。

## 主要改动

- 新增 `src/plugins/miniprogram.ts`；
- `src/contracts.ts` 注册 `miniprogram` 必填字段：`projectPath`、`runner`；
- `src/cli.ts` 注册 `miniprogramPlugin`；
- 新增 `src/harness/host-gate.ts`，负责宿主临时候选工作区 materialization 和清理；
- `src/harness/sandbox/environment.ts` 在 Daytona run 中拆分 remote contracts 和
  host-local contracts；
- 新增插件、host gate、Daytona mixed gate、feedback/escalation、CLI 和模板测试；
- 新增 `examples/miniprogram/`，提供页面 smoke、点击、表单、跳转和异步状态模板；
- 文档补齐 `docs/architecture/gate-plugin-guide.md` 和
  `docs/architecture/daytona-sandbox-gate.md`。

## 契约示例

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

runner 会收到：

```text
HARNESS_MINIPROGRAM_PROJECT
HARNESS_MINIPROGRAM_PROJECT_ABS
HARNESS_MINIPROGRAM_WS_ENDPOINT
HARNESS_MINIPROGRAM_DEVTOOLS_PORT
```

## 真实本机验证

创建了隔离 smoke 项目：

```text
/Users/zhongyy40/dev/harness-miniprogram-smoke
```

验证命令：

```bash
cd /Users/zhongyy40/dev/harness-miniprogram-smoke
npm run gate
```

最终结果：

```text
outcome=pass
pass 1/1
exitCode=0
```

实测观察：

- `miniprogram-automator` 可直连 `ws://127.0.0.1:9420`；
- 能看到微信开发者工具界面自动打开页面并点击；
- `cli auto` 帮助只展示 `--port`，但 automation WebSocket 实测使用隐藏参数
  `--auto-port`；
- DevTools CLI 对相对 `--project` 不稳定，插件使用 realpath 后的绝对路径；
- `cli auto` 返回后 WebSocket 可能尚未 ready，runner 模板内置 connect retry；
- DevTools CLI 需要 `HOME` 读取本机配置目录，插件只 allowlist 传 `HOME`，
  不透传其它 ambient env。

## 模板库

`examples/miniprogram/` 提供 5 类可复制模板：

| Contract | Runner | 用途 |
|---|---|---|
| `page-smoke.yaml` | `miniprogram-page-smoke.js` | 打开页面并断言关键文本 |
| `tap-flow.yaml` | `miniprogram-tap-flow.js` | 点击按钮并等待状态变化 |
| `form-input.yaml` | `miniprogram-form-input.js` | 输入表单、提交、断言结果 |
| `navigation.yaml` | `miniprogram-navigation.js` | 点击入口后断言目标路由 |
| `async-state.yaml` | `miniprogram-async-state.js` | mock `wx.request` 并等待异步 UI 状态 |

## 后续建议

- 在真实业务项目中将稳定 selector 作为契约的一部分维护；
- 对需要后端的流程，优先在 runner 中 mock `wx.request` 或连接可控测试后端；
- 对关键流程逐步沉淀业务契约，不需要一次性穷举所有小程序 API；
- 如果后续要把 smoke 项目纳入仓库，可从
  `/Users/zhongyy40/dev/harness-miniprogram-smoke` 提取为 fixture 或 example。

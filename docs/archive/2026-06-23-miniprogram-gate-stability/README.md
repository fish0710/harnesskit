# MiniProgram Gate Stability Archive

归档日期：2026-06-23

当前分支：`main`

## 背景

本轮来自一次真实小程序门禁运行中的问题复盘。目标不是修复某个业务小程序
runner，而是让 Harness 本身更稳定地执行 `type: miniprogram` 门禁，并让
`harness-prep` skill 正确指导 agent 编写小程序契约和 runner。

已确认的关键事实：

- 小程序门禁应保持 host-local：微信开发者工具运行在 macOS 宿主机，不放进
  Daytona Agent/Gate sandbox。
- Daytona agent 负责修改代码和产出构建 artifact，Harness 再把候选文件
  materialize 到宿主临时工作区，由 host-local miniprogram gate 连接本机
  DevTools 自动化 WebSocket。
- `cli auto` 返回成功不等于 `ws://127.0.0.1:<autoPort>` 已经可连接，runner
  可能立刻遇到 `Failed connecting to ws://127.0.0.1:<port>`。
- uni-app/Vue3 编译后 Page data 和方法形态不稳定，runner 不应依赖
  `page.callMethod()` 或 raw `page.data()` 去验证业务行为。

## 最终机制

- `miniprogram` 插件在 managed DevTools 启动成功后，会等待
  `127.0.0.1:<autoPort>` TCP 就绪，再启动 runner。
- 该等待只作用于本地 host 执行路径；远端/fake execution 测试仍保持原有
  command-order 语义。
- DevTools 启动仍只透传最小环境，主要保留 `HOME` 以读取本机微信开发者工具配置。
- `harness-prep` 新增小程序门禁专门指南，明确：
  - miniprogram gate 是 host-local；
  - 契约使用编译产物 `projectPath` 和 host-owned `test/gates` runner；
  - old/new 双门禁使用不同 `autoPort`；
  - 需要本机 DevTools 安装、自动化安全设置和必要登录状态；
  - runner 优先断言可见 UI、稳定 selector、路由、文本和列表状态；
  - 避免 `page.callMethod()`、raw `page.data()`、生成组件内部 selector。
- `examples/miniprogram` 模板补齐 `inputText`、`tapElement`、
  `triggerElement` helper，并在 README 中写明 uni-app/Vue3 注意事项。
- 测试覆盖插件端口等待、模板语法、skill 文档必须包含 host-local 和 runner
  反模式指导。

## 交付物

| 产出 | 路径 |
|---|---|
| Managed DevTools readiness wait | [miniprogram.ts](../../../src/plugins/miniprogram.ts) |
| Miniprogram plugin regression | [miniprogram-plugin.test.ts](../../../test/miniprogram-plugin.test.ts) |
| Template and skill regression | [miniprogram-templates.test.ts](../../../test/miniprogram-templates.test.ts) |
| 小程序模板 README | [README.md](../../../examples/miniprogram/README.md) |
| 小程序模板 helpers | [miniprogram-template-helpers.js](../../../examples/miniprogram/test/gates/miniprogram-template-helpers.js) |
| harness-prep skill 入口 | [SKILL.md](../../../plugins/harness-prep/skills/harness-prep/SKILL.md) |
| 小程序门禁指南 | [miniprogram-gates.md](../../../plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md) |
| Contract/config 指引 | [contracts-and-config.md](../../../plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md) |
| Gate translation 指引 | [gate-translation.md](../../../plugins/harness-prep/skills/harness-prep/references/gate-translation.md) |
| Plugin manifest | [plugin.json](../../../plugins/harness-prep/.codex-plugin/plugin.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## Scope Notes

本轮不把业务项目 `/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab` 的 runner
改动纳入 Harness 仓库。此前为诊断临时改过的
`test/gates/mp-behavior-runner.js` 已撤回；业务项目中仍保留生成出的
`vue3-app/dist/build/mp-weixin/` 和 `vue3-app/package-lock.json`，它们不属于本
Harness commit。

## 归档结论

Harness 现在对 managed 小程序门禁的本机 DevTools 连接竞态更稳；`harness-prep`
也会把 agent 引导到 host-local 小程序门禁模型和 UI-level runner 写法，避免把
业务 runner 绑定到 uni-app/Vue 编译内部。

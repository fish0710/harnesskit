# MiniProgram Artifact-first Defaults Archive

归档日期：2026-06-24

当前分支：`codex/miniprogram-artifact-defaults`

## 背景

真实 `/Users/zhongyy40/workspace/miniprogram` Harness run 复盘显示，小程序
门禁最稳定的默认模型不是在 Gate 里重新安装依赖和重建项目，而是让 Agent 沙箱
自行完成框架相关构建，然后把编译后的小程序产物交给 Harness 门禁消费。

这次 run 中 `mp.counter` host-local 小程序行为门禁已经能打开
`dist/build/mp-weixin` 并真实点击按钮验证计数加 1；相反，Gate 侧的
`npm ci` / build 流程容易把失败原因转移到网络、Node 版本、包生命周期脚本或
框架构建链上，反馈不再贴近用户行为。

## 最终机制

- Harness 小程序默认指导采用 artifact-first：Agent 或项目工作流构建产物，
  Harness `miniprogram` gate 只消费 `projectPath`。
- `miniprogram` 插件保持框架无关，不内置 uni-app、Taro 或原生小程序构建支持。
- Gate 侧 rebuild 被定义为可选的 source reproducibility command contract，
  不属于默认小程序行为门禁。
- `gateSetup: []` 是默认小程序行为门禁路径，除非其他远端契约确实需要 setup。
- examples 和 harness-prep skill 明确：模板假设小程序构建产物已经存在。

## 交付物

| 产出 | 路径 |
|---|---|
| Artifact-first implementation plan | [plan](../../../docs/superpowers/plans/2026-06-24-miniprogram-artifact-first-defaults.md) |
| Harness prep mini-program guidance | [miniprogram-gates.md](../../../plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md) |
| Contracts/config guidance | [contracts-and-config.md](../../../plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md) |
| Miniprogram examples README | [README.md](../../../examples/miniprogram/README.md) |
| Template guidance regression test | [miniprogram-templates.test.ts](../../../test/miniprogram-templates.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

小程序任务的默认 Harness 设计应验证“Agent 交付的小程序成品能否被微信开发者
工具打开并通过真实用户行为门禁”，而不是默认验证“另一个 Gate 环境能否重新
安装依赖并复现构建”。

## Residual Risk

- 这次是指导和测试更新，不改变 runtime plugin 行为。
- 用户仍需保证 Agent 任务文本明确要求构建并发布 `projectPath`。
- 若团队需要源码可复现构建，仍可显式增加 `type: command` rebuild contract；
  这类失败应归类为 source reproducibility failure，而不是小程序行为失败。

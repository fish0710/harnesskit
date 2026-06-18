# Harness Prep Plugin Archive

归档日期：2026-06-18

## 背景

本轮目标是把 Harness 前置准备流程封装成一个可由 Codex / Claude Code 加载的 plugin skill，降低用户直接编辑 Harness 配置和契约的门槛。

用户希望自然语言需求进入后，由 agent 负责：

- 执行或指导 `harness create`；
- 访谈并整理需求、非目标、必须保留原则、任务清单和功能清单；
- 把自然语言门禁翻译成 typed contracts 或 `review` gates；
- 写出 `harness.config.json`、task series、sandbox policy 和 setup 说明；
- 在 `harness run` 期间解释当前状态、人工 review、阻断原因和 Daytona/Claude 观测链路。

## 当前结论

新增本地 Codex plugin：

```text
plugins/harness-prep/
```

它包含一个 `harness-prep` skill，面向 agent 而不是最终用户。用户只需要确认关键产品/风险决策；配置、契约和运行解释由 agent 按 skill 指南完成。

## 交付内容

```text
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/SKILL.md
plugins/harness-prep/skills/harness-prep/agents/openai.yaml
plugins/harness-prep/skills/harness-prep/references/*.md
```

主要 reference：

- `prep-workflow.md`：从需求到 spec / plan / config / run 的准备流程。
- `agent-environment.md`：Agent/Gate 环境盘点、candidateRoots、protectedPaths、setup、secrets、Daytona/Claude env。
- `gate-translation.md`：自然语言门禁到 `command` / `http` / `structure` / `boot` / `invariant` / `miniprogram` / `review` 的翻译规则。
- `contracts-and-config.md`：契约和 `harness.config.json` 模板。
- `run-supervision.md`：`harness run` 启动、进度汇报、outcome 处理、series 监督。
- `observability-and-review.md`：运行记录、review gate、Daytona `.claude` artifact 查询。
- `runstore-observability.md`：RunStore v3 查询、single/series/series-task、parent/child、Claude artifact 关联。
- `blocker-analysis.md`：host / agent / gate / publication / git 五个面向的阻断归因。
- `source-evidence.md`：把 skill 声称映射到 Harness 当前源码、文档和测试。
- `reliability-checks.md`：能力矩阵、前后置 checklist、pressure scenarios、证据等级。

## RunStore 补强

在 main 合入 `b4a9049 Merge branch 'codex/unified-runstore'` 后，本轮把 RunStore 信息同步进 skill：

- 以 `harness runs list/show --json` 作为首选查询入口；
- 明确 `.harness/runs/<runId>.json` 是 RunStore v3 记录；
- 区分 `kind: "single"`、`kind: "series"`、`kind: "series-task"`；
- 说明 `selectedContracts`、`attempts`、`events`、`logs`、`report`、`publication`、`children`；
- 明确 RunStore 是审计/诊断层，`.harness/series/<series-id>.json` 是 resume/commit ledger；
- 说明 `.claude` 文件不复制进 RunStore，只通过 `runId`、volume、mount、session id 定位。

## 明确边界

- 该 plugin 不实现 Harness runtime；它是 agent 使用 Harness 的操作指南。
- 该 plugin 不替用户做产品/风险决策；主观判断必须落 `review` 并等待用户裁决。
- 该 plugin 不把 secret 写入仓库文件。
- 当前验证覆盖 plugin/skill schema、引用完整性、Markdown 结构和 Harness 测试套件；尚未单独启动 fresh agent pressure scenario 执行完整端到端行为测试。

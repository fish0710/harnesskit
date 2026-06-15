# Daytona Sandbox Gate 产出归档

> 归档日期：2026-06-15
>
> 实现分支：`codex/daytona-sandbox-gate`
>
> 最终实现提交：`eb3b63b`

## 归档目的

本目录记录 Harness 将 mutating agent 默认迁移到 Daytona 沙箱，并把门禁决策
保留在沙箱外的完整产出。归档采用“索引 + 提交账本 + 原始文档链接”的方式，
避免复制设计文档后产生版本漂移。

## 交付物

| 产出 | 路径 |
|---|---|
| 当前架构设计 | [daytona-sandbox-gate.md](../../architecture/daytona-sandbox-gate.md) |
| 信任边界架构图 | [trust-boundary-architecture.png](../../assets/daytona-sandbox-gate/trust-boundary-architecture.png) |
| Agent/Gate 循环图 | [agent-gate-loop.png](../../assets/daytona-sandbox-gate/agent-gate-loop.png) |
| 原始设计规格 | [2026-06-11-daytona-sandbox-gate-design.md](../../superpowers/specs/2026-06-11-daytona-sandbox-gate-design.md) |
| 实施计划 | [2026-06-11-daytona-sandbox-gate.md](../../superpowers/plans/2026-06-11-daytona-sandbox-gate.md) |
| 本地运行手册 | [daytona-local-claude-code-runbook.md](../../daytona-local-claude-code-runbook.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |
| 图片生成溯源 | [image-prompts.md](image-prompts.md) |

## 最终系统形态

- 一个 agent sandbox 跨重试持续存在；
- 每轮创建一个没有 agent 和模型凭证的全新 gate sandbox；
- 宿主从 agent 沙箱收集实际文件字节并生成候选快照；
- 宿主 `GateCore` 对 gate 沙箱返回的原始证据进行分类；
- 失败诊断反馈给原 agent 沙箱继续循环；
- `blocked`、重复失败或预算耗尽进入人工处理；
- 通过后只发布该轮门禁实际验证过的精确候选字节。

## 主要代码边界

```text
src/harness/run.ts
  -> src/harness/sandbox/environment.ts
     -> src/harness/sandbox/daytona.ts
     -> src/harness/sandbox/workspace.ts
     -> src/harness/sandbox/publish.ts
  -> src/gate.ts
     -> src/plugins/*
     -> src/harness/execution.ts
```

## 归档结论

当前实现满足已确认的方案 1：

1. query/agent 动作在 Daytona 沙箱内运行；
2. gate 执行使用独立全新沙箱；
3. gate 沙箱中没有 agent；
4. 裁决控制、循环预算和发布留在宿主；
5. agent 无法通过输出、Git 状态或伪造报告干预最终决策。

图片由原生图像生成工具生成，并经过人工技术一致性复核。Markdown 中的文字描述
和源码是最终权威，图片用于帮助理解边界与流程。

# 图片生成溯源

两张图片均于 2026-06-15 使用 Codex 原生 `image_gen` 工具生成，最终文件保存到：

```text
docs/assets/daytona-sandbox-gate/trust-boundary-architecture.png
docs/assets/daytona-sandbox-gate/agent-gate-loop.png
```

## 信任边界架构图

用途：在架构文档中展示宿主控制面、持久 agent 沙箱、全新 gate 沙箱和可信决策
边界。

最终提示词要点：

```text
Create a technically strict enterprise architecture diagram.
Keep HOST CONTROL PLANE separate from both Daytona sandboxes with a visible
TRUST BOUNDARY. Contracts, GateCore, verdicts, retry/escalation, candidate
collector, candidate assembler, and atomic publisher stay on the host.
The persistent agent sandbox contains Claude Code, model credentials, and an
untrusted candidate workspace. The fresh gate sandbox contains no agent and no
model credentials. Host GateCore sends trusted command requests; the gate
sandbox returns only raw evidence. Atomic Publisher writes only exact evaluated
bytes to the host workspace. The gate sandbox is recreated and deleted for every
attempt; the agent sandbox persists across retries.
```

首个草稿因错误暗示 contracts 进入 gate sandbox，并给 publisher 增加了
commit/tag 行为而被弃用。归档仅保留修正后的版本。

## Agent/Gate 循环图

用途：展示 baseline、agent 执行、候选收集、独立门禁、证据分类、反馈循环、
人工 review、升级和发布。

最终提示词要点：

```text
Create a left-to-right Daytona-backed Harness lifecycle flowchart:
HOST CAPTURE BASELINE -> CREATE OR REUSE AGENT SANDBOX -> RUN AGENT COMMAND ->
HOST COLLECTS CANDIDATE BYTES -> CREATE FRESH GATE SANDBOX -> RESTORE TRUSTED
TEST ASSETS -> RUN CONTRACT COMMANDS -> RETURN RAW EVIDENCE TO HOST -> HOST
GATECORE CLASSIFIES.

PASS -> ATOMIC PUBLISH -> CLEANUP.
FAIL or ERROR -> SANITIZED FEEDBACK -> SAME AGENT SANDBOX.
BLOCKED -> HUMAN REVIEW.
BUDGET EXHAUSTED -> ESCALATE.

Show that the agent sandbox persists, the gate sandbox is fresh and deleted
after every attempt, only the host classifies outcomes, and only exact evaluated
candidate bytes are published.
```

## 复核标准

- 不把 agent 输出画成 gate verdict；
- 不把 contracts 或模型凭证放入 gate 沙箱；
- 不暗示 gate 沙箱拥有最终判定权；
- 不增加 merge、commit、tag 或自动批准等未实现行为；
- 图片与 Markdown 冲突时，以源码和 Markdown 为准。

# Gate Runtime Clean Build Guidance Archive

归档日期：2026-06-24

当前分支：`main`

## 背景

真实 `/Users/zhongyy40/workspace/miniprogram` Harness run 复盘显示，
`mp.counter.parity` 这类 host-local 小程序行为门禁可以验证 Agent 产出的
`dist/build/mp-weixin` 是否能被微信开发者工具导入并保持真实点击行为一致。

同一次 run 中，额外的 `uniapp.vue3-build` 远端重建门禁连续失败，导致
Harness 升级为人工确认。这个失败更接近 source reproducibility 问题：
干净 Gate runtime 是否能重新安装依赖并从源码构建产物，而不是小程序行为本身
是否正确。

## 最终机制

- `harness create` 生成 `docs/reference/harness-runtime.md`，让 Agent 能读到
  Gate runtime 的固定事实。
- scaffold 默认 `readOnlyPaths` 包含 `docs/reference`，Agent 可读但不能发布
  对 runtime 文档的修改。
- scaffolded `AGENTS.md` 指向 `docs/reference/harness-runtime.md`，要求涉及
  依赖、构建、`agentSetup`、`gateSetup` 或远端 command/http 门禁时先读它。
- harness-prep skill 同步要求把 `docs/reference` 作为只读上下文。
- 小程序指导新增 `Clean Build Final Task`：严格干净重建应作为 series 最后
  一个 source-reproducibility task，而不是和行为 parity 任务混在一起。

## 交付物

| 产出 | 路径 |
|---|---|
| Implementation plan | [plan](../../../docs/superpowers/plans/2026-06-24-gate-runtime-clean-build-guidance.md) |
| Scaffold runtime reference generation | [scaffold.ts](../../../src/harness/scaffold.ts) |
| Default read-only policy | [policy.ts](../../../src/harness/sandbox/policy.ts) |
| Harness prep mini-program guidance | [miniprogram-gates.md](../../../plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md) |
| Sandbox snapshot guidance | [sandbox-snapshots.md](../../../plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md) |
| Scaffold regression tests | [scaffold.test.ts](../../../test/scaffold.test.ts) |
| Policy regression tests | [sandbox-policy.test.ts](../../../test/sandbox-policy.test.ts) |
| Guidance regression tests | [miniprogram-templates.test.ts](../../../test/miniprogram-templates.test.ts) |
| Snapshot guidance tests | [daytona-gate-snapshot.test.ts](../../../test/daytona-gate-snapshot.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

干净环境可重建是有价值的必要门禁，但对小程序迁移任务不应默认和行为门禁
捆绑。更稳的任务结构是：先用 artifact-first 小程序门禁验证可运行产物和
真实行为，再用最后一个 series task 专门收敛 clean build 可复现性。

## Residual Risk

- 这次没有新增 `harness runtime describe`，runtime reference 仍是 scaffolded
  markdown 文档。
- 具体项目仍需要在 spec/plan/config 中选择是否添加 clean build final task。
- 若默认 Gate snapshot 继续演进，`docs/reference/harness-runtime.md` 的内容
  需要跟 `toolchain.ts` 和 `sandbox-snapshots.md` 保持同步。

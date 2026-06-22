# Gate Node 14 Runtime Snapshot Archive

归档日期：2026-06-22

当前分支：`main`

## 背景

目标项目 `/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab` 的 Gate
setup 需要按 `.nvmrc` 使用 Node 14.21.3。旧的
`harness-gate-runtime-latest` 默认只有 Node 22.14.0 可直接使用，虽然有
`/usr/local/nvm/nvm.sh`，但 `/usr/local/nvm` 由 root 拥有。Gate 里的
`nvm install 14.21.3` 会尝试写 `/usr/local/nvm/.cache`，对 `daytona`
用户失败。

## 最终机制

- Gate 默认运行时仍是 Node 22.14.0，`/usr/local/bin/node/npm/npx` 不切到
  Node 14。
- Gate snapshot 预装 Node 14.21.3 和 npm 6.14.18。
- Gate release 升级为 `harness-gate-runtime-node-22.14.0-r2`。
- stable latest 名称保持 `harness-gate-runtime-latest`。
- Gate image build preflight 验证 Node 22 默认值和 Node 14/npm 6 可用。
- Gate latest snapshot preflight 还验证 `! command -v claude`。
- 从 Agent runtime 清理复制成 Gate latest 的 fallback 路径也会先以 root
  预装 Node 14，再创建 snapshot。

## 交付物

| 产出 | 路径 |
|---|---|
| Gate Dockerfile | [Dockerfile](../../../images/daytona/gate/Dockerfile) |
| Toolchain pins | [toolchain.ts](../../../src/harness/sandbox/toolchain.ts) |
| Gate snapshot publisher | [daytona-gate-snapshot.ts](../../../src/tools/daytona-gate-snapshot.ts) |
| Gate snapshot tests | [daytona-gate-snapshot.test.ts](../../../test/daytona-gate-snapshot.test.ts) |
| Toolchain tests | [daytona-toolchain.test.ts](../../../test/daytona-toolchain.test.ts) |
| Harness Prep snapshot guidance | [sandbox-snapshots.md](../../../plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

`harness-gate-runtime-latest` 已重新发布并处于 active 状态。新 Gate sandbox
可以直接 `source /usr/local/nvm/nvm.sh && nvm use 14.21.3`，输出
`v14.21.3` 和 npm `6.14.18`。目标项目根 `gateSetup` 原始命令已在 fresh
Gate sandbox 中验证通过，不再触发 `/usr/local/nvm/.cache` permission
denied。

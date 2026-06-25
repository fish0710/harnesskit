# Daytona Claude Examples Archive

归档日期：2026-06-25

工作分支：`feat/daytona-claude-examples`

## 背景

这次工作补齐 Harness 的真实 Daytona/Claude examples。目标不是写只能本地
`check` 的示例，而是提供设置 Daytona 和 Anthropic 环境变量后可以直接跑
`harness run --driver claude` 的代表性案例。

这些 examples 用来证明 Harness 的核心优势：

- Claude Agent 在 Daytona Agent sandbox 中修改候选文件；
- 每轮 Gate 使用新的、无 Agent/Claude 凭证的 Gate sandbox；
- Gate 失败诊断会回喂给 Agent 并触发 retry/resume；
- 只有 Gate 验过的候选 bytes 会发布回 host；
- RunStore 和 series ledger 能记录 attempts、sandbox、contracts 和 publication。

## 交付物

| 产出 | 路径 |
|---|---|
| Design spec | [spec](../../../docs/superpowers/specs/2026-06-25-daytona-claude-examples-design.md) |
| Implementation plan | [plan](../../../docs/superpowers/plans/2026-06-25-daytona-claude-examples.md) |
| Feedback retry HTTP example | [resume-health-port](../../../examples/resume-health-port) |
| CLI TDD example | [daytona-cli-tdd](../../../examples/daytona-cli-tdd) |
| Configured task-series example | [daytona-task-series](../../../examples/daytona-task-series) |
| Example drift tests | [daytona-examples.test.ts](../../../test/daytona-examples.test.ts) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## Example Coverage

### `examples/resume-health-port`

This example starts from a product-red but runtime-ready baseline. The protected
HTTP contract checks `127.0.0.1:3320`, while the task text includes a conflicting
product note for port `3321`.

Live run result:

- Run id: `2026-06-25T07-22-22-166Z-cef45125`
- Outcome: `ready_for_mr`
- Attempt 1: Claude changed the service to port `3321`; Gate failed.
- Attempt 2: same Agent sandbox and same Claude session resumed, changed back to
  port `3320`; Gate passed.
- Published file: `examples/resume-health-port/src/server.js`

This demonstrates Gate feedback retry and strong Claude session resume.

### `examples/daytona-cli-tdd`

This example starts with a failing CLI stub and protected Node tests. Claude may
edit only `bin/quote.js`; tests and Harness config are read-only/protected.

Live run result:

- Run id: `2026-06-25T07-39-40-351Z-e1864ae9`
- Outcome: `ready_for_mr`
- Attempts: 1
- Gate result: `cli.behavior` pass
- Published file: `examples/daytona-cli-tdd/bin/quote.js`

This demonstrates ordinary executable acceptance criteria through a command
contract.

### `examples/daytona-task-series`

This example uses configured `tasks` in `harness.config.json`: first implement
the domain model, then implement the service layer. Each task gets its own
Agent/Gate loop and selected contracts.

Live run result:

- Parent series run id: `2026-06-25T07-45-35-843Z-c3804e60`
- Parent outcome: `completed`
- Child task `define-domain-model`: run id
  `2026-06-25T07-45-35-910Z-a3475db2`, Gate `domain.model` pass, published
  `examples/daytona-task-series/src/domain-model.js`.
- Child task `implement-order-service`: run id
  `2026-06-25T07-50-29-747Z-cbf8a195`, Gate `domain.model` and
  `order.service` pass, published
  `examples/daytona-task-series/src/order-service.js`.

This demonstrates task-series orchestration, task-specific Gate selection,
parent/child run records, and a completed series ledger.

## Final Mechanism

- Examples document the required Daytona and Anthropic environment variable
  names but never store secret values.
- Example READMEs use `npm run build` and `node dist/src/cli.js`, so they work
  from the source checkout without relying on a global `harness` binary.
- `candidateRoots` are narrow implementation-owned paths.
- `TASK.md`, `package.json`, and tests are read-only context where appropriate.
- Contracts, config, and `.harness` remain protected.
- Host-local tests validate example contract loading, sandbox policy boundaries,
  task-series contract selection, required README run commands, and referenced
  files.

## 归档结论

The examples were verified both locally and with real Daytona/Claude runs. The
feedback retry, CLI command-contract, and configured task-series workflows all
completed successfully. The live runs were executed in a disposable `/tmp`
repository copy so the committed examples remain red/teachable baselines rather
than already-solved examples.

## Residual Risk

- Claude behavior is nondeterministic. The executable contracts are the source
  of truth; READMEs describe expected outcomes, not exact transcripts.
- Live verification used the environment and snapshots available on
  2026-06-25. Future Daytona snapshot drift can affect setup or timings.
- The examples intentionally keep baselines product-red. Users should run them
  in a disposable copy or branch if they want to preserve the baseline files.

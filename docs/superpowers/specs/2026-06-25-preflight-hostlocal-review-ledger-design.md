# Preflight Host-Local Contract And Review Ledger Resume Design

## Purpose

Fix two Harness workflow failures found in real task-series runs:

1. A WeChat mini-program behavior gate modeled as `type: command` is treated as
   a remote Daytona Gate contract. It can hang or fail before reaching the
   Agent because the real automation depends on macOS WeChat DevTools.
2. A task blocked by a `review` contract remains stopped after
   `harness review --resolve` writes an approving verdict, because series
   resume stops on the ledger `blocked` status before rerunning GateCore with
   the stored verdict.

The fix should preserve the existing execution-domain boundaries:

- ordinary `command` contracts run in the remote Gate sandbox;
- mini-program behavior gates run as `type: miniprogram` in the host-local
  domain;
- human review verdicts are resolved by GateCore, not by directly marking a
  ledger task completed.

## Non-Goals

- Do not add a general `hostLocal: true` command mode.
- Do not silently reinterpret arbitrary `type: command` contracts as host-local
  contracts.
- Do not mutate a blocked series task to `completed` only because a verdict
  exists.
- Do not auto-resume `escalated` or `error` ledger tasks.
- Do not change local `harness check` semantics for valid `command` contracts.

## Mini-Program Command Misclassification

### Problem

`isHostLocalContract()` currently returns true only when
`contract.type === "miniprogram"`. That is correct for valid contracts, but a
contract such as `mp.vue2.home-flow` or `mp.vue3.home-flow` can be generated as
`type: command` even though it represents real WeChat DevTools automation.

During `harness preflight gate`, this contract is classified as remote and sent
to the Daytona Gate sandbox. The Gate sandbox is Linux and cannot operate the
macOS WeChat DevTools runtime. The preflight can appear stuck while no Agent has
started, as shown by run records containing only `gate.preflight.start`.

### Design

Add a fail-fast contract-modeling check in the Gate preflight static phase. The
check scans selected `type: command` contracts for strong mini-program
automation signals and emits a readiness error before creating a Daytona Gate
sandbox.

Strong signals include command contract fields that belong to the mini-program
contract shape or runner ecosystem:

- `projectPath`;
- `runner`;
- `devtools`;
- command text or args that refer to `miniprogram-automator`,
  `wechatwebdevtools`, `WeChatDevTools`, or `HARNESS_MINIPROGRAM_`.

The error should be explicit:

- the contract is modeled as `type: command`;
- WeChat mini-program behavior gates must be `type: miniprogram`;
- use `projectPath`, `runner`, and `devtools` instead of a remote command gate;
- use ordinary `type: command` only for remote-executable build, test, lint, or
  source-reproducibility checks.

The preflight report remains `outcome: "not_ready"` and exits with code 1.
Because the error is static, the command must not create a Daytona Gate sandbox.

### Data Flow

1. Load and select contracts exactly as preflight does today.
2. Run existing Gate runtime lint.
3. Run the mini-program command modeling check.
4. If any static errors exist, return the current static-error preflight shape:
   selected contracts, remote/host-local id lists, static findings, and
   readiness errors.
5. Otherwise continue with host-local readiness and remote Gate rehearsal.

This intentionally leaves `isHostLocalContract()` strict. A malformed command is
not made host-local; it is rejected so the project fixes the contract YAML.

## Review Verdict Resume

### Problem

When a task stops on a `review` contract, `runTaskSeries()` writes the task to
the series ledger as `status: "blocked"`. Later,
`harness review --resolve <contract> ...` records a verdict in
`.harness/verdicts.json`, but it does not update the series ledger.

On the next `harness run --driver scaffold` or equivalent series resume,
`decideTaskResume()` sees `blocked` and returns `stop` before selected contracts
are run again. GateCore never receives `ctx.verdicts`, so the stored verdict is
ignored unless the user manually edits the ledger task back to `pending` or
`running`.

### Design

Make series resume verdict-aware for blocked review tasks. A blocked task may
rerun only when all of these are true:

- the existing ledger task status is `blocked`;
- the ledger task hash matches the current task hash;
- the task's selected contracts include at least one `type: review` contract;
- at least one selected review contract has a stored verdict in
  `.harness/verdicts.json`.

When those conditions are true, the resume decision is `run`. The existing
execution path updates the ledger task to `running`, reruns the selected gates,
lets GateCore resolve the review result with the stored verdict, and records the
normal completed, ready-to-commit, failed, blocked, or escalated outcome.

Blocked tasks without a matching stored review verdict still stop with the
existing manual-handling message. `escalated` and `error` statuses also keep the
existing stop behavior.

### Interface Shape

Extend the resume decision input rather than reading files inside
`decideTaskResume()`:

```ts
decideTaskResume({
  taskId,
  taskHash,
  ledgerTask,
  hasResolvedReviewVerdict,
})
```

The value defaults to false so existing unit tests and call sites keep their
current semantics unless explicitly opted into the verdict-aware behavior.

`runTaskSeries()` already receives the full contract list and can select task
contracts before a run. To avoid changing selection semantics, it should compute
the selected contracts before calling `decideTaskResume()` and derive
`hasResolvedReviewVerdict` from:

- selected contracts with `type === "review"`;
- verdict ids loaded from `.harness/verdicts.json`.

Selection failures remain setup errors and must not be hidden by a blocked
ledger entry.

## Error Handling

Mini-program command modeling errors are readiness errors. They are not product
failures and they must not be fed to the Agent as implementation feedback.

Verdict-aware resume is conservative:

- task hash drift still stops;
- missing verdict still stops;
- invalid verdict option is handled by GateCore as an error when rerun;
- a pass verdict does not skip the task; it only permits the gate to rerun and
  produce a fresh ledger outcome.

## Tests

Add focused tests for the two regressions:

- `isHostLocalContract` remains strict: `type: command` is not host-local.
- Gate preflight returns `not_ready` and creates no sandbox for a selected
  command contract that contains mini-program contract fields such as
  `projectPath`, `runner`, or `devtools`.
- Gate preflight error text tells the user to use `type: miniprogram`.
- Ordinary command contracts remain remote and continue through existing
  preflight behavior.
- `decideTaskResume()` keeps stopping blocked tasks by default.
- `decideTaskResume()` returns `run` for a blocked task with matching hash and
  `hasResolvedReviewVerdict: true`.
- `runTaskSeries()` reruns a blocked review task when a matching verdict exists
  and then completes the series.
- `runTaskSeries()` does not rerun blocked non-review tasks or review tasks
  without a verdict.

Run targeted tests first, then the full suite:

```bash
npm run build
node --test dist/test/host-gate.test.js dist/test/preflight-runtime.test.js dist/test/harness-series.test.js
npm run check
```

The full suite may need to run outside the filesystem sandbox because existing
tests bind `127.0.0.1`.

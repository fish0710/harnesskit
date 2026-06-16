# Mini-Program Host Gate Design

## Purpose

Add a first-class `miniprogram` contract type for WeChat mini-program validation.
Claude or command agents still run in Daytona sandboxes. The mini-program gate
itself runs on the host because WeChat DevTools is a macOS-local GUI/runtime and
its automation WebSocket is not a good fit for remote Linux gate sandboxes.

The feature must validate the exact candidate bytes produced by the sandboxed
agent before those bytes are published to the real working tree.

## Contract Shape

```yaml
id: mp.home.smoke
type: miniprogram
scenario: 小程序首页和关键交互必须通过自动化契约
projectPath: dist/dev/mp-weixin
runner: test/gates/miniprogram-runner.js
devtools:
  mode: managed
  cliPath: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
  autoPort: 9420
  trustProject: true
timeoutMs: 120000
expectExit: 0
```

Required fields are `projectPath` and `runner`. `expectExit` defaults to `0`,
`timeoutMs` defaults to the existing command timeout behavior, and
`devtools.mode` defaults to `managed`.

The runner is a host-controlled test script. It can use `miniprogram-automator`
and should exit non-zero when assertions fail. Harness does not trust structured
pass/fail JSON from the runner; stdout and stderr are diagnostics only.

## Execution Domains

There are three distinct execution domains:

- Agent domain: Daytona agent sandbox for `--driver claude` and
  `--driver command`.
- Remote gate domain: fresh Daytona gate sandbox for normal command, HTTP,
  structure, boot, invariant, and review contracts.
- Host-local gate domain: host process and temporary host workspace for
  `miniprogram` contracts.

`harness check` and `harness gate` already run on the host. In those commands,
`miniprogram` contracts execute against the current working tree.

`harness run` with Daytona agents uses mixed gate execution. It collects the
agent candidate snapshot, runs non-`miniprogram` contracts in the remote gate
sandbox, materializes the same candidate snapshot into a temporary host
workspace, and runs `miniprogram` contracts against that temporary workspace.
Only if the combined gate report passes does publisher write the candidate to
the real working tree.

## Candidate Materialization

Host-local mini-program validation must never mutate the real working tree
during a Daytona run. The run environment creates a temporary directory, writes
the baseline files plus candidate files into it, removes files deleted by the
candidate, restores protected files from the host baseline, and executes the
mini-program runner from that directory.

The materialized workspace is treated as disposable. It is removed after gate
execution unless a future explicit debug-retain option is added. A cleanup
failure is an infrastructure error and must prevent publication.

## Mini-Program Plugin

`src/plugins/miniprogram.ts` implements `Plugin` with type `miniprogram`.

The plugin validates contract fields on the host:

- missing `projectPath` or `runner` is `error`;
- non-string paths are `error`;
- path traversal or absolute runner/project paths are `error`;
- missing runner or missing project directory is `error`;
- missing `project.config.json` under `projectPath` is `error`;
- missing DevTools CLI in `managed` mode is `error`;
- runner exit code not equal to `expectExit` is `fail`;
- spawn failure, timeout, or incomplete evidence is `error`.

The plugin uses host-owned command evidence with a host-generated execution ID.
It may reuse the existing command evidence validation helpers. The command it
executes is the configured Node runner with environment variables such as:

- `HARNESS_MINIPROGRAM_PROJECT`
- `HARNESS_MINIPROGRAM_WS_ENDPOINT`
- `HARNESS_MINIPROGRAM_DEVTOOLS_PORT`

For `managed` mode, the plugin starts WeChat DevTools using:

```text
cli auto --project <materialized-project-path> --auto-port <port> --trust-project
```

Then it runs the runner. The runner can either read the provided WebSocket
endpoint from environment variables or derive it from the port. The plugin
disconnects only its runner process; it should not assume it can safely close
the user's global DevTools application unless a later explicit lifecycle mode is
added.

## Mixed Gate Aggregation

`DaytonaRunEnvironment.runGate()` splits selected contracts:

- remote contracts: every contract except `type: "miniprogram"`;
- host-local contracts: `type: "miniprogram"`.

If one side has no contracts, it is skipped. If both sides run, their
`CheckResult[]` are concatenated and passed through the existing `aggregate()`
function. Existing `needs_review`, `fail`, and `error` semantics remain
unchanged.

The remote gate still verifies protected files before and after remote contract
execution. Host-local mini-program execution uses a temporary workspace with
protected files restored from baseline, so an agent cannot edit the runner,
contracts, or Harness policy.

## Feedback Loop And Escalation

Mini-program failures participate in the existing run loop exactly like other
gate failures:

- `fail` means the mini-program assertions ran and found a behavioral mismatch;
- `error` means DevTools, the runner, candidate materialization, or evidence
  collection did not run correctly;
- both `fail` and `error` are included in diagnostics generated by
  `runLoop()` and fed back to the same Daytona agent sandbox on the next
  attempt;
- `pass` resets that check's failure streak;
- repeated failure of the same mini-program contract counts toward
  `repeatWallThreshold` and can escalate to `human_review_contract`;
- attempt, time, and token budgets still escalate to `stop_for_human`;
- `needs_review` remains blocked and does not auto-iterate.

Diagnostics should include the contract ID, exit code mismatch or infrastructure
error, and a bounded stdout/stderr tail from the runner. They must not include
secrets or unbounded screenshots.

## Safety Boundaries

The host-local gate is not a sandbox. It is a controlled integration test that
requires local WeChat DevTools. The safety guarantees are:

- mutating agent work remains in Daytona;
- host-local validation uses a temporary materialized candidate, not the real
  working tree;
- protected assets come from the host baseline;
- the runner's pass/fail text is not trusted as a `CheckResult`;
- publication happens only after combined gate aggregation passes;
- cleanup failure blocks publication.

## Documentation

Update `docs/architecture/gate-plugin-guide.md` with a `miniprogram` section and
explicitly document that the plugin runs in the host-local gate domain.

Update `docs/architecture/daytona-sandbox-gate.md` to mention mixed gate
execution and explain that mini-program validation is intentionally outside the
Daytona gate sandbox because it depends on host-local WeChat DevTools.

## Tests

Implementation must be TDD-driven. Required coverage:

- contract loader requires `projectPath` and `runner` for `miniprogram`;
- plugin passes on exit `0` with trusted command evidence;
- plugin fails on non-zero exit and includes bounded diagnostics;
- plugin errors on missing runner, missing project, missing `project.config.json`,
  missing DevTools CLI, spawn errors, timeout, invalid evidence ID, and invalid
  exit evidence;
- local `harness check` registers and executes the plugin;
- Daytona environment splits remote and host-local contracts;
- host-local materialization uses candidate bytes, not the real working tree;
- combined gate fail feeds diagnostics back to the agent on the next attempt;
- repeated mini-program failure contributes to `human_review_contract`
  escalation;
- cleanup failure prevents publication.

## Out Of Scope

This feature does not install WeChat DevTools, create a universal network tunnel
from Daytona to the host, close the user's GUI application, or implement a full
mini-program assertion DSL. The runner remains a project-owned Node script.

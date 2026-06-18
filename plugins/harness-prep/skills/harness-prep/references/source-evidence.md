# Source Evidence Map

Use this when you need to justify the workflow or verify that this skill still matches the current Harness implementation.

Do not treat this file as a replacement for source inspection. It is an index of evidence anchors. If the Harness code has changed, rerun `rg` and refresh the claim before telling the user.

## Create And Configuration Surface

Evidence anchors:

- `docs/usage.md`: documents `harness create .`, generated files, default no-overwrite behavior, `harness.config.json`, contract validation, review, run, and task series usage.
- `src/cli.ts`: defines the CLI commands, options, built-in gate plugin registration, contract validation flow, and check exit codes.
- `src/harness/scaffold.ts`: creates the Harness project files used by `harness create`.

Claims supported:

- A prep agent can run `harness create .` to generate `AGENTS.md`, `harness.config.json`, `contracts/`, `docs/`, `CODEOWNERS`, `.github/workflows/harness-gate.yml`, and `.harness/`.
- Existing scaffold files are not overwritten unless the user explicitly approves `--force`.
- Pre-run validation should use `harness contract validate`, `harness check`, and `harness status` before starting an implementation agent.

## Contracts And Gate Semantics

Evidence anchors:

- `src/types.ts`: defines `Status`, `DecisionRequest`, `Contract`, `Plugin`, `GateReport`, and exit-code semantics.
- `src/gate.ts`: dispatches each contract by `type`; unknown plugin types and plugin exceptions become `error`.
- `src/aggregate.ts`: makes any `fail` or `error` block as `fail`; unresolved `needs_review` becomes `blocked` with exit code 2.
- `docs/architecture/gate-plugin-guide.md`: documents contract structure, host-side evidence classification, native plugin types, and review semantics.
- `src/plugins/*.ts`: implements native contract types.

Claims supported:

- Natural-language acceptance criteria must be translated into typed contracts.
- Unsupported or malformed gates must not be treated as pass.
- Subjective product, UX, compatibility, migration, or risk judgments belong in `review`, not in a fake automatic check.
- `review` blocks automation until a user verdict is recorded.

## Sandbox Policy And Environment

Evidence anchors:

- `docs/usage.md`: explains `candidateRoots`, `protectedPaths`, `agentSetup`, `gateSetup`, and limits.
- `src/harness/sandbox/policy.ts`: defines defaults and validates candidate paths, protected paths, setup fields, and limits.
- `src/harness/sandbox/environment.ts`: builds agent and gate sandbox execution.
- `src/harness/sandbox/toolchain.ts`: pins Node.js, Claude Code, Agent/Gate image names, latest snapshot names, and Claude preflight checks.
- `src/tools/daytona-agent-snapshot.ts` and `src/tools/daytona-gate-snapshot.ts`: verify or create latest Agent/Gate snapshots and run toolchain preflight in short-lived Daytona sandboxes.
- `docs/architecture/daytona-sandbox-gate.md`: describes the host control plane, persistent Agent sandbox, fresh Gate sandbox, gate setup, retry, blocked review, publication, and observability flow.

Claims supported:

- The implementation agent can only publish configured candidate paths and must not overwrite protected paths.
- Agent setup and Gate setup are separate because the Agent edits while Gate validates in a fresh environment.
- HTTP contracts against `127.0.0.1` in Daytona Gate mode need the service started inside the Gate sandbox.
- Environment ambiguity should be resolved before `harness run`; otherwise failures are likely config/runtime `error`, not product failures.
- Default latest snapshots provide Node/npm/npx and Python, but Gate intentionally lacks Claude/model credentials; setup commands must account for tools absent from the snapshots.

## Run Loop, Publication, And Git

Evidence anchors:

- `src/harness/run.ts`: implements Agent attempt -> Gate attempt -> feedback/retry -> `ready_for_mr`, `blocked`, or `escalated`.
- `src/harness/sandbox/publish.ts`: validates and transactionally publishes only candidate bytes accepted by policy.
- `src/harness/record.ts`: defines RunStore v3 records, `single`/`series`/`series-task` kinds, parent/child links, CLI-readable validation, legacy v1/v2 last-run compatibility, attempts, events, logs, reports, publication, and errors.
- `src/cli.ts`: creates run records before fallible single-run setup, creates series parent/child records, and exposes `harness runs list/show`.
- `src/harness/series.ts`: parses task series, series ledger, task statuses, task setup error hooks, and auto-commit behavior.
- `docs/usage.md`: documents single-task runs, no-position configured series, per-task gates, and series auto-commit behavior.
- `README.md`: summarizes Daytona sandbox execution, observability, publication, and configured series behavior.
- `docs/archive/2026-06-18-unified-runstore/README.md`: summarizes the RunStore merge and operational boundaries.

Claims supported:

- Passing a gate publishes evaluated candidate bytes to the host workspace; it is not the same as merge approval.
- Single-task runs do not imply a git commit.
- Configured series can auto-commit gate-approved publications, and `.harness` runtime records should remain separate from committed source changes.
- `blocked`, `escalated`, and `error` need different explanations and next actions.
- RunStore is the primary persisted audit/query layer for `harness run`; the series ledger remains the resume/commit progress layer.

## Observability And Blocker Analysis

Evidence anchors:

- `src/harness/record.ts`: defines `.harness/runs/<runId>.json` schema v3, including kind, parent/child links, repo/task metadata, attempts, sandbox ids, Claude session ids, observability config, events, logs, report, publication, outcome, summary, action, and error reason.
- `src/harness/observability.ts`: defines default Daytona observability volume and mount paths.
- `docs/architecture/daytona-sandbox-gate.md`: describes `.claude` persistence, `CLAUDE_CONFIG_DIR`, strong resume, Gate sandbox separation, and run manifest events.
- `docs/architecture/daytona-langfuse-observability.md`: explains host-side Langfuse versus Daytona `.claude` artifact boundaries.
- `test/run-store.test.ts`, `test/cli-run-record.test.ts`, and `test/cli-series.test.ts`: cover RunStore records, query commands, early failures, and series parent/child links.

Claims supported:

- Status explanations should separate host run state, Agent sandbox state, Gate sandbox state, publication state, and git state.
- Use `harness runs list/show --json` first; raw `.harness/runs` reads are fallback.
- For configured series, diagnose both the parent `kind: "series"` record and the stopped `kind: "series-task"` child.
- Claude artifacts are operational evidence, not gate authority.
- Missing env, bad snapshot, volume mount failure, setup failure, or malformed config should be classified as infrastructure/config failure before blaming implementation.
- Daytona file API inspection should use absolute mounted paths such as `/harness-observability`.

## Tests That Back These Claims

Evidence anchors:

- `test/gate.test.ts`: covers unknown plugins, plugin errors, aggregation, and review verdict parsing.
- `test/loader-selector.test.ts`: covers contract loading and validation.
- `test/sandbox-policy.test.ts`: covers sandbox policy parsing and protected/candidate path rules.
- `test/harness-run.test.ts`: covers run loop outcomes, blocked review, escalation, and publication behavior.
- `test/daytona-sandbox.test.ts`, `test/daytona-claude*.test.ts`, and `test/observability.test.ts`: cover Daytona adapter, Claude env/resume, and observability behavior.
- `test/harness-series.test.ts` and `test/cli-series.test.ts`: cover configured task series, ledger behavior, and auto-commit paths.

When evaluating this plugin itself, schema validation proves the plugin can load, and the Harness test suite proves the current repo still satisfies its own behavior. Neither replaces an end-to-end pressure test in a fresh agent session.

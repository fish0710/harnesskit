# Daytona Claude Examples Design

## Current Request

The user wants real Harness examples that can run end to end when Daytona and
Anthropic environment variables are supplied. The examples should be
representative and demonstrate why Harness is useful: a mutating Claude Agent
sandbox, a fresh agent-free Gate sandbox, gate diagnostics fed back into the
agent, publication of only gate-approved candidate bytes, durable run records,
and configured task-series execution.

## Goal

- Provide runnable Daytona/Claude examples rather than placeholder contracts.
- Make each example self-contained enough to copy or run from the repository.
- Show the exact environment variables and commands required to run the
  examples with `node dist/src/cli.js`.
- Cover single-task feedback retry, command/test driven implementation, and
  task-series orchestration.
- Add automated repository tests that keep example contracts, configs, and
  run instructions from silently drifting.

## Non-goals

- Do not create local-only examples as the primary deliverable.
- Do not write Daytona, Anthropic, model, proxy, or Langfuse secrets into the
  repository.
- Do not require WeChat DevTools or mini-program tooling for this work.
- Do not make the examples depend on host-global `harness`; examples should use
  the source checkout command after `npm run build`.
- Do not change Harness runtime behavior unless a real example exposes a
  blocking bug that must be fixed for the examples to run.

## Must Preserve

- `contracts/`, `harness.config.json`, `.harness`, CI files, and trusted gate
  runners remain protected from implementation agents.
- `TASK.md`, docs, package manifests, lockfiles, and other setup context are
  read-only unless an example task explicitly needs dependency changes.
- Gate setup starts sandbox-local services for HTTP contracts; HTTP loopback
  points to the Gate sandbox, not the host.
- Gate contracts and setup do not invoke Claude or require Anthropic
  credentials.
- Examples are small and deterministic enough for repeated Daytona runs.
- Existing unrelated worktree changes are not modified.

## User Decisions

| Decision | Current answer | Blocks execution? |
|---|---|---|
| Example target environment | Daytona + Anthropic required | no |
| Include local-only examples | Not as primary deliverable | no |
| Recommended scope | Three representative examples | no |

## Example Set

### 1. Feedback Retry HTTP Service

Create or normalize a Daytona/Claude example that asks Claude to implement a
small HTTP health endpoint. The initial task intentionally includes a mismatch
that makes a naive first implementation fail the Gate contract. Harness then
feeds the HTTP diagnostic back into the same Claude run loop and a later attempt
can fix the candidate.

This example demonstrates:

- Agent and Gate are separate sandboxes.
- The Gate HTTP contract checks the candidate service in the Gate sandbox.
- Gate diagnostics are actionable and fed back to Claude.
- The run record captures attempts, gate reports, and observability metadata.

### 2. CLI Test-Driven Implementation

Add a small Node CLI example where the baseline project contains tests and
documentation but lacks the implementation behavior. Claude must implement the
CLI under a narrow candidate root. Gate runs deterministic command contracts,
such as `npm test` or direct CLI behavior checks.

This example demonstrates:

- Harness works for ordinary code tasks, not only HTTP services.
- Command contracts can encode executable acceptance criteria.
- The Agent can read task/spec/test context without publishing protected gate
  assets.

### 3. Configured Task Series

Add or replace the current command-driver series example with a Daytona/Claude
series example. The config should define two tasks, each with specific contracts
and a clear final artifact. The example should explain the series ledger,
parent/child run records, and resume behavior.

This example demonstrates:

- Large work can be split into explicit tasks in `harness.config.json`.
- Each task receives its own Agent/Gate loop and gate selection.
- Harness records series progress and can skip completed unchanged tasks.

## File Layout

Each Daytona example should have this shape unless there is a strong reason to
deviate:

```text
examples/<example-name>/
  README.md
  TASK.md
  harness.config.json
  package.json
  contracts/
    *.yaml
  src/ or bin/
  test/ or scripts/
```

The README must include:

- Required environment variable names with redacted placeholders.
- `npm run build` from the Harness source checkout.
- Exact `node dist/src/cli.js run ... --driver claude ...` command.
- Expected result and how to inspect `.harness/runs`.
- Notes about Agent sandbox, Gate sandbox, protected paths, and read-only paths.

## Contracts And Config

- Use `command` contracts for CLI/test examples.
- Use `http` contracts for the feedback retry service, with `gateSetup`
  starting the sandbox-local service.
- Use explicit `tasks` and task-specific gate contracts for the task-series
  example.
- Keep dependency setup deterministic with `npm ci` or avoid third-party
  dependencies where possible.
- Prefer Node built-ins and simple scripts so Gate setup remains fast.
- Do not freeze contracts in this change unless a contract is stable and the
  repository already expects frozen examples in that directory.

## Testing

Automated tests should verify the examples without requiring Daytona credentials:

- Example contract directories load and validate successfully.
- `harness.config.json` files define safe candidate, protected, and read-only
  boundaries.
- README files include required Daytona/Anthropic environment names and exact
  run commands.
- Any included scripts or tests that do not require a mutating Agent can run
  locally after `npm run build`.

Manual verification with credentials should be documented as:

```bash
export DAYTONA_API_KEY="<daytona-key>"
export ANTHROPIC_AUTH_TOKEN="<model-token>"
export ANTHROPIC_BASE_URL="<model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"
npm run build
node dist/src/cli.js run "<task>" --driver claude --dir <example>/contracts --config <example>/harness.config.json --max-attempts 3
```

## Risks

- Claude behavior can vary. Mitigation: examples use clear tasks and executable
  gates; README describes expected outcomes rather than assuming a fixed
  transcript.
- Daytona snapshot drift can break setup. Mitigation: rely on Node/npm already
  present in the default snapshots and document optional snapshot env vars.
- Examples can rot if not exercised in CI. Mitigation: add host-local tests for
  contract/config/doc structure and runnable non-Agent checks.
- Task-series auto-commit may surprise users. Mitigation: document the behavior
  explicitly and choose `autoCommit.enabled` intentionally per example.

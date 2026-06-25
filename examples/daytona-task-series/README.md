# Daytona Task Series Example

This example demonstrates Harness configured task-series execution with a real
Daytona-backed Claude Agent. The work is split into two explicit tasks: first
the domain model, then the service layer. Each task gets its own Agent sandbox,
Gate selection, child run record, and ledger entry.

The checked-in source files intentionally throw. The protected tests and
contracts are product-red until Claude implements the requested files.

## Required Environment

Export credentials in your shell. Do not write them into this repository.

```bash
export DAYTONA_API_KEY="<daytona-key>"
export DAYTONA_API_URL="<optional-daytona-api-url>"
export ANTHROPIC_AUTH_TOKEN="<model-token>"
export ANTHROPIC_BASE_URL="<model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"
```

Optional snapshot overrides:

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-latest"
export HARNESS_DAYTONA_GATE_SNAPSHOT="harness-gate-runtime-latest"
```

## Run

Run from the Harness repository root after building the source checkout CLI.
Do not pass a task string; Harness reads the configured `tasks` array.

```bash
npm run build
node dist/src/cli.js run --driver claude --dir examples/daytona-task-series/contracts --config examples/daytona-task-series/harness.config.json --max-attempts 3
```

## Expected Result

- The Agent sandbox may edit only `examples/daytona-task-series/src`.
- The Agent sandbox can read `TASK.md`, `package.json`, and `test`, but cannot
  publish edits to them.
- Harness hides and protects the contracts and config from the Agent.
- Task `define-domain-model` runs only the `domain.model` contract.
- Task `implement-order-service` runs both `domain.model` and `order.service`.
- Each task uses a fresh Agent sandbox and fresh Gate sandbox attempts.
- `autoCommit.enabled` is `false` so the example does not create git commits in
  your checkout. Published files remain in the worktree for inspection.

Inspect the series ledger and run records:

```bash
cat .harness/series/daytona-order-series.json
node dist/src/cli.js runs list --series-id daytona-order-series --json
```

The parent series run and child task runs are stored under `.harness/runs`.
If you rerun with the same config after both tasks complete, Harness can skip
completed task ids whose task hashes have not changed.

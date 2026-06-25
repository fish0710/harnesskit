# Daytona CLI TDD Example

This example demonstrates an ordinary code task gated by executable tests.
Harness sends Claude into a Daytona Agent sandbox with only the CLI
implementation as a mutable candidate root. A fresh Gate sandbox then runs the
protected command contract.

The checked-in CLI intentionally fails. Claude must read `TASK.md`, update
`bin/quote.js`, and satisfy the protected Node tests without editing tests or
Harness config.

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

Run from the Harness repository root after building the source checkout CLI:

```bash
npm run build
node dist/src/cli.js run "Read examples/daytona-cli-tdd/TASK.md and implement the CLI behavior." --driver claude --dir examples/daytona-cli-tdd/contracts --config examples/daytona-cli-tdd/harness.config.json --max-attempts 3
```

## Expected Result

- The Agent sandbox may edit only `examples/daytona-cli-tdd/bin`.
- The Agent sandbox can read `TASK.md`, `package.json`, and `test`, but cannot
  publish edits to them.
- Harness hides and protects the contract and config from the Agent.
- The Gate sandbox runs `cd examples/daytona-cli-tdd && npm test` without
  Anthropic credentials or Claude installed.
- A passing Gate publishes only the CLI implementation bytes evaluated by Gate.

Inspect the latest host run record:

```bash
RUN_FILE="$(ls -t .harness/runs/*.json | head -1)"
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify({runId:r.runId,status:r.status,outcome:r.outcome,attempts:r.attempts,summary:r.summary}, null, 2))' "$RUN_FILE"
```

The run record under `.harness/runs` links the Agent attempt logs, selected
contracts, final Gate report, and publication metadata.

# Resume Health Port Daytona Example

This example demonstrates the Harness feedback loop with a real
Daytona-backed Claude Agent sandbox and a fresh Gate sandbox.

The checked-in baseline server starts on the protected contract port, so
preflight can prove the Gate runtime is ready. It intentionally returns
`{"ready": false}`, so the baseline is product-red rather than readiness-red.
Claude then edits only `examples/resume-health-port/src/server.js`.

The task text includes a product note that says port `3321`, while the protected
HTTP contract checks `http://127.0.0.1:3320/health`. If Claude follows the note
too literally, the first Gate attempt fails and Harness feeds the diagnostic
back into the same Agent sandbox. A later attempt should satisfy the protected
contract.

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
node dist/src/cli.js run "Read examples/resume-health-port/TASK.md and implement it. Treat Harness gate feedback as authoritative if it conflicts with the task text." --driver claude --dir examples/resume-health-port/contracts --config examples/resume-health-port/harness.config.json --max-attempts 3
```

## Expected Result

- The Agent sandbox may edit only `examples/resume-health-port/src`.
- The Agent sandbox can read `TASK.md` and `package.json` but cannot publish
  edits to them.
- Harness hides and protects the contracts and config from the Agent.
- Each Gate attempt uses a fresh Gate sandbox without Claude credentials.
- Gate setup starts the candidate server inside the Gate sandbox, then the HTTP
  contract checks `GET /health`.
- The final passing candidate publishes only the server file bytes evaluated by
  Gate.

Inspect the host run record:

```bash
RUN_FILE="$(ls -t .harness/runs/*.json | head -1)"
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify({runId:r.runId,status:r.status,outcome:r.outcome,attempts:r.attempts,selectedContracts:r.selectedContracts}, null, 2))' "$RUN_FILE"
```

Claude observability is stored under the Daytona volume
`harness-claude-observability` at run subpath `runs/<runId>`. In the Agent
sandbox the mounted run root is `/harness-observability`, and Claude native
state is copied under `/harness-observability/.claude`.

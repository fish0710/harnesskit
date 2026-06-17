# harnesskit

Harness runs mutating `claude` and `command` agents in Daytona by default.
The agent works in one persistent sandbox. Every gate attempt runs in a new
agent-free sandbox, while contracts, aggregation, retry, escalation, and
publication remain in the host process.

## Run

Configure `DAYTONA_API_KEY` and the Anthropic variables listed in
`docs/daytona-local-claude-code-runbook.md`, then run:

```bash
npm run build
node dist/src/cli.js run "implement the task" --driver claude
```

Daytona Claude runs create a durable run record before the remote agent starts:

```text
.harness/runs/<runId>.json
```

By default, the agent sandbox also mounts Daytona volume
`harness-claude-observability` at `/harness-observability`, scoped to
`runs/<runId>`. Claude Code receives:

```text
CLAUDE_CONFIG_DIR=/harness-observability/attempt-<n>/.claude
```

Use the run record to correlate host-side events, sandbox ids, gate attempts,
and the persisted `.claude` artifacts after the sandbox is deleted.

`--driver command --agent-cmd "..."` uses the same Daytona isolation.
There is no silent fallback to host execution. `--driver scaffold` is the only
local mode and performs no mutations.

Candidate roots, protected paths, setup commands, and byte limits are read
from `harness.config.json`. A passing gate publishes only the exact candidate
bytes evaluated by the fresh gate sandbox.

Unit tests do not require Daytona:

```bash
npm run check
```

The real integration flow is explicit:

```bash
npm run test:daytona
```

## Architecture And Archive

- [Current Daytona sandbox gate architecture](docs/architecture/daytona-sandbox-gate.md)
- [Local Daytona runbook](docs/daytona-local-claude-code-runbook.md)
- [2026-06-17 observability persistence archive](docs/archive/2026-06-17-daytona-claude-observability-persistence/README.md)
- [2026-06-15 implementation archive](docs/archive/2026-06-15-daytona-sandbox-gate/README.md)

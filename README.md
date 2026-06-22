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

Runs create a durable v3 run record before the agent/gate loop starts:

```text
.harness/runs/<runId>.json
```

The same `RunStore` schema is used for `scaffold`, `command`, `claude`, and
configured task-series children. The record includes repo identity, task
metadata, selected contracts, attempts, logs, the full final Gate report, and
publication metadata. Query persisted records with:

```bash
node dist/src/cli.js runs list --json
node dist/src/cli.js runs show <runId> --json
```

By default, the agent sandbox also mounts Daytona volume
`harness-claude-observability`, scoped to `runs/<runId>`. The run root is
mounted at `/harness-observability`. Claude writes its native `.claude` state
to the sandbox-local home path `/home/daytona/.claude`; Harness copies that
directory into the mounted run root after each Claude command.
Harness does not set `CLAUDE_CONFIG_DIR`; Claude keeps writing its default
home `.claude` state there. Claude Code receives:

```text
HARNESS_CLAUDE_STREAM_PATH=/harness-observability/attempt-<n>/claude-stream.jsonl
HARNESS_CLAUDE_HOME_SNAPSHOT_DIR=/harness-observability/.claude
```

The sandbox paths are stable so gate-fail retries can resume the same Claude
conversation. The first Claude attempt captures the stream-json session id;
later retries run `claude --resume <sessionId>` in the same agent sandbox.
Missing or inconsistent resume state fails closed instead of starting a fresh
conversation. Cross-run isolation still comes from the Daytona mount subpath:
each run maps `/harness-observability` to `runs/<runId>`.

Use the run record to correlate host-side events, sandbox ids, gate attempts,
persisted `.claude` artifacts, and each attempt's raw `claude-stream.jsonl`
after the sandbox is deleted. When inspecting the run subpath later, the native
Claude `.claude` files are visible at `/harness-observability/.claude`; the
full assistant/tool stream is recorded in `claude-stream.jsonl`.

`--driver command --agent-cmd "..."` uses the same Daytona isolation.
There is no silent fallback to host execution. `--driver scaffold` is the only
local mode and performs no mutations.

Candidate roots, protected paths, setup commands, and byte limits are read
from `harness.config.json`. A passing gate publishes only the exact candidate
bytes evaluated by the fresh gate sandbox.

Large work can be split into a configured task series:

```json
{
  "series": { "id": "order-refactor" },
  "taskDefaults": {
    "gate": { "contracts": ["smoke.boot"] }
  },
  "autoCommit": {
    "enabled": true,
    "messageTemplate": "harness: task {index}/{total} {id}"
  },
  "tasks": [
    {
      "id": "extract-domain-model",
      "task": "Extract the order domain model.",
      "gate": { "contracts": ["domain.model-boundary"] }
    },
    {
      "id": "split-order-service",
      "task": "Split order service responsibilities.",
      "gate": { "stage": "service-refactor" }
    }
  ]
}
```

Run the configured series without a positional task:

```bash
node dist/src/cli.js run --driver claude --max-attempts 3 --max-ms 6000000
```

Each configured task starts a fresh Agent sandbox and records progress in
`.harness/series/<series-id>.json`. By default, Harness creates one git commit
per gate-approved publication and leaves `.harness` run records and ledgers out
of those commits. A series run also creates a parent `kind=series` run record;
each configured task creates a `kind=series-task` child record linked by
`parentRunId`, `seriesId`, and `taskId`.

Unit tests do not require Daytona:

```bash
npm run check
```

Before starting a Daytona-backed implementation agent, verify Gate runtime
readiness:

```bash
node dist/src/cli.js preflight gate --dir contracts --config harness.config.json
```

This command creates a short-lived Gate sandbox and catches setup/toolchain
errors before they consume agent attempts.

The real integration flow is explicit:

```bash
npm run test:daytona
```

## Architecture And Archive

- [Usage manual](docs/usage.md)
- [Current Daytona sandbox gate architecture](docs/architecture/daytona-sandbox-gate.md)
- [Local Daytona runbook](docs/daytona-local-claude-code-runbook.md)
- [2026-06-22 transcript persistence archive](docs/archive/2026-06-22-daytona-claude-transcript-persistence/README.md)
- [2026-06-17 observability persistence archive](docs/archive/2026-06-17-daytona-claude-observability-persistence/README.md)
- [2026-06-15 implementation archive](docs/archive/2026-06-15-daytona-sandbox-gate/README.md)

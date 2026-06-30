# Daytona Sandbox Gate Runbook

Related documents:

- [Current architecture](architecture/daytona-sandbox-gate.md)
- [2026-06-22 transcript persistence archive](archive/2026-06-22-daytona-claude-transcript-persistence/README.md)
- [2026-06-15 implementation archive](archive/2026-06-15-daytona-sandbox-gate/README.md)

## Architecture

`harness run --driver claude` creates one persistent Daytona agent sandbox.
After each agent attempt, the host downloads and hashes the allowed candidate
files. It then creates a fresh gate sandbox with no agent and no model
credentials. `GateCore` and all pass/fail/retry/escalation decisions stay on
the host.

The gate sandbox is assembled from the host baseline. The candidate is then
applied, protected files are restored from the host snapshot, host-configured
`gateSetup` runs, outbound network access is blocked when safe, and gate
commands collect raw evidence. Only the host plugins classify that evidence.

An accepted candidate is published from the retained host snapshot. Harness
does not recollect the live agent workspace after a pass.

## Required Environment

```bash
export DAYTONA_API_KEY="<daytona-key>"
export DAYTONA_API_URL="http://localhost:3000/api" # optional default
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-latest" # optional override
export HARNESS_DAYTONA_GATE_SNAPSHOT="harness-gate-runtime-latest" # optional override
export ANTHROPIC_AUTH_TOKEN="<short-lived-model-token>"
export ANTHROPIC_BASE_URL="<approved-model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"
# Optional overrides. If omitted, Harness uses SONNET for ANTHROPIC_MODEL
# and OPUS for ANTHROPIC_REASONING_MODEL.
export ANTHROPIC_MODEL="<model>"
export ANTHROPIC_REASONING_MODEL="<model>"
```

The SDK adapter appends `localhost`, `127.0.0.1`, `.localhost`, and
`proxy.localhost` to both `NO_PROXY` and `no_proxy`. This prevents local
Daytona toolbox traffic from being sent through an ambient HTTP proxy.

Model variables are passed only to the Claude PTY. They are not sandbox-level
environment variables and are never passed to gate sandboxes. Use scoped,
short-lived model credentials: the model token is necessarily visible to the
agent process and this design does not claim to prevent source disclosure to
the approved model endpoint.

Daytona Claude artifact persistence is enabled by default. Harness records the
host-side run manifest before the remote agent starts and mounts a Daytona
volume into the agent sandbox:

```bash
export HARNESS_DAYTONA_OBSERVABILITY=1 # optional; default-on
export HARNESS_DAYTONA_OBSERVABILITY_VOLUME="harness-claude-observability"
export HARNESS_DAYTONA_OBSERVABILITY_MOUNT="/harness-observability"
```

Set `HARNESS_DAYTONA_OBSERVABILITY=0` only when the volume path itself is
broken and you need to run without `.claude` persistence. The run manifest will
still record that observability was disabled.

For every Claude attempt, the remote Claude command writes the full
`--output-format stream-json` stdout directly to the mounted run directory and
then replays the same file back to Harness for session parsing:

```text
/harness-observability/attempt-<n>/claude-stream.jsonl
```

The RunStore attempt entry records this as `claudeStreamPath`. Use this file as
an independent durable source for assistant text, tool_use, and tool_result
events alongside the copied native `.claude/projects/...jsonl`.

Agent and Gate Snapshots are selected by the host control plane before sandbox
creation. If the environment variables are absent, Harness defaults to
`harness-agent-claude-latest` and `harness-gate-runtime-latest`. Gate sandboxes
never receive model credentials or Langfuse credentials.

For a remote Daytona control plane, set `DAYTONA_API_URL` to the remote API
endpoint and provide the key through the shell environment. Do not commit API
keys or model tokens to this repository.

If a local proxy such as `127.0.0.1:7897` is closed, clear proxy variables for
remote Daytona runs:

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="daytona.wieimmer.asia,localhost,127.0.0.1,proxy.localhost,.localhost"
```

## Agent Image And Snapshot

Claude Code is no longer installed during `harness run`. The agent image is
built once with pinned tool versions:

```text
Node.js: 22.14.0
Claude Code: 2.1.145
Docker image: harness-daytona-claude:2.1.145-r2
Registry image: registry:6000/harness/harness-daytona-claude:2.1.145-r2
Immutable Agent source Snapshot: harness-agent-claude-2.1.145-r2
Default Agent Snapshot: harness-agent-claude-latest
Default Gate Snapshot: harness-gate-runtime-latest
```

Build or replace the stable runtime Snapshots:

```bash
source ~/.zshrc
npm run snapshot:runtime
```

`npm run snapshot:agent` derives `harness-agent-claude-latest` from the
immutable r2 Snapshot and verifies:

```text
/usr/local/bin/node
/usr/local/bin/npm
/usr/local/bin/npx
/usr/local/bin/claude
/usr/bin/bash
```

`npm run snapshot:gate` derives `harness-gate-runtime-latest`, removes Claude
from the derived sandbox, and verifies `/usr/bin/bash`, Node.js, npm, npx,
python3, curl, and `command -v claude` failure.

Both scripts print the final `export HARNESS_DAYTONA_*_SNAPSHOT=...` line after
verification succeeds. To replace an existing latest Snapshot:

```bash
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:runtime
```

Upgrade requires a new immutable revision such as `r3`, then replacing the
stable latest Snapshots. Rollback is selecting the previous immutable Snapshot
value in the host environment or republishing latest from that source.

Useful diagnosis commands:

```bash
docker exec daytona-runner-1 docker images \
  'registry:6000/harness/harness-daytona-claude'
npm run snapshot:agent
npm run snapshot:gate
npm run test:daytona
npm run test:daytona:pty
```

Remove old Snapshots only after confirming no active run references them.

## Policy

`harness.config.json` contains the trust policy:

```json
{
  "sandbox": {
    "candidateRoots": ["src", "test/generated", "package.json"],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates"
    ],
    "agentSetup": [],
    "gateSetup": [],
    "limits": {
      "maxFiles": 10000,
      "maxFileBytes": 10485760,
      "maxTotalBytes": 209715200
    },
    "retainOnFailure": false
  }
}
```

Only regular files under candidate roots can change. Protected paths,
contracts, verdicts, trusted gate tests, CI configuration, and Harness runtime
remain host-owned. Symlinks, special files, ambiguous paths, aliases, and
oversized candidates fail closed.

## Commands

```bash
npm run build
node dist/src/cli.js run "implement the task" --driver claude
node dist/src/cli.js run "implement the task" \
  --driver command --agent-cmd "./tools/agent.sh"
```

There is no fallback from Daytona to a host agent. Missing Daytona
configuration stops the run before an agent command executes.

Each `--driver claude` run writes a manifest before provider creation:

```text
.harness/runs/<runId>.json
```

The manifest includes the task, driver, status, Daytona volume name, mount
path, durable run root, raw observation events, agent sandbox id, gate sandbox
ids, attempts, gate outcome, and error reason when a failure occurs. Harness
does not redact this file; treat `.harness/runs` as sensitive operational data.

The default durable artifact location is:

```text
Daytona volume: harness-claude-observability
Durable run root: /harness-observability/runs/<runId>
Mounted in sandbox as: /harness-observability
Claude native config/state in sandbox: /home/daytona/.claude
Copied durable native .claude path: /harness-observability/runs/<runId>/.claude
```

Because the volume mount is scoped to `runs/<runId>`, the sandbox sees the run
root as `/harness-observability`, while the host-side manifest records the
durable path `/harness-observability/runs/<runId>`. Harness does not mount the
volume directly on `/home/daytona/.claude`; Claude Code writes to sandbox-local
home, then Harness copies that directory to `/harness-observability/.claude`
after each Claude command. This avoids the Daytona volume mount behavior that
causes native session JSONL to keep only startup events when mounted directly as
`$HOME/.claude`.

Claude retries use strong resume. The first attempt captures the stream-json
session id; later gate-fail attempts run `claude --resume <sessionId>` in the
same agent sandbox and reuse `/home/daytona/.claude`. Missing or
inconsistent resume state fails closed instead of starting a fresh conversation.

## Recovering a retained failed run

Inspect the run first:

```bash
harness runs show <runId> --json
```

If the run was retained, has `attempts[].agentSandboxId`, and does not have an
`agent.cleanup.end` event that deleted the sandbox, confirm the conservative
resume checks before proceeding: the source run started from a clean worktree,
the current `HEAD` still matches that source run, the current source worktree is
clean outside `.harness` runtime records, the run recorded selected contracts,
and the attempt has either
`claudeSessionId` or a recoverable `claudeStreamPath`. Resolve any host-side
runtime or configuration issue without changing the source `HEAD` or leaving
source changes, then resume explicitly:

```bash
harness runs resume <runId> --max-attempts 2
```

If an older source run recorded `repo.dirty: true` only because Harness-owned
setup files were untracked when the run started, use the explicit rescue flag:

```bash
harness runs resume <runId> --allow-harness-dirty-source --max-attempts 2
```

The flag does not permit product source changes. Harness validates the current
dirty paths and only allows `.harness`, contracts, `test/gates`, Harness config,
`.github/workflows`, `CODEOWNERS`, `AGENTS.md`, and Harness docs paths. Any
dirty path such as `src/**`, package files, app pages, or build outputs still
fails closed.

Resume is Gate-first. Harness attaches the retained Agent sandbox, collects the
existing candidate, and runs Gate before starting another Claude turn. If the
fixed Gate passes, Harness publishes the retained candidate without another
Claude command. If Gate still fails, Harness feeds the new diagnostics into
`claude --resume <sessionId>` inside the same sandbox.

Interrupted local orchestrator runs can leave the source run at
`status=running` and without `claudeSessionId`. In that case resume reads the
recorded `claudeStreamPath`; a successful stream result such as
`{"type":"result","subtype":"success","session_id":"..."}` or the equivalent
`sessionId` form is treated as a recovered successful command, and the
recovered session id is used for later resume attempts.

TODO: Improve HTTP gate diagnostics for connection failures. A minimal resume
fixture showed that `fetch failed` is enough to trigger a retry, but not always
enough for the resumed agent to infer the actionable fix. HTTP diagnostics
should include the request method, full target URL, raw error, and a concise
hint that the candidate may be listening on a different host or port than the
contract target.

To inspect a run after sandbox cleanup:

```bash
RUN_FILE="$(ls -t .harness/runs/*.json | head -1)"
node -e 'const r=require(process.argv[1]); console.log({runId:r.runId,status:r.status,runRoot:r.observability.runRoot,attempts:r.attempts})' "$RUN_FILE"
```

Use Daytona's volume inspection or a temporary sandbox mounted with the same
volume/subpath to browse the corresponding native `.claude` directory:

```text
/harness-observability/.claude
```

Use the host manifest `.harness/runs/<runId>.json` to correlate that artifact
with attempt numbers, sandbox ids, gate outcomes, and failures. In current
Harness runs, native `.claude/projects/...jsonl` is copied from the sandbox-local
home after the command. The RunStore attempt `claudeStreamPath` remains the
independent complete assistant/tool_use/tool_result stream.

Run unit tests without external services:

```bash
npm run check
```

Run the opt-in real service test:

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
npm run test:daytona
npm run test:daytona:pty
```

The integration test creates a temporary Git worktree, uses one Claude agent
sandbox, validates the result in a separate gate sandbox, publishes the exact
passing bytes, and deletes the sandboxes.

The PTY integration test creates a temporary Agent sandbox from the selected
Snapshot, creates the harness workspace directory, opens a real Daytona PTY
session, verifies a sentinel command, and deletes the sandbox.

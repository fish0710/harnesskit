# Daytona Sandbox Gate Runbook

Related documents:

- [Current architecture](architecture/daytona-sandbox-gate.md)
- [2026-06-15 implementation archive](archive/2026-06-15-daytona-sandbox-gate/README.md)

## Architecture

`harness run --driver claude` creates one persistent Daytona agent sandbox.
After each agent attempt, the host downloads and hashes the allowed candidate
files. It then creates a fresh gate sandbox with no agent and no model
credentials. `GateCore` and all pass/fail/retry/escalation decisions stay on
the host.

The gate sandbox is assembled from the host baseline. Host-configured
`gateSetup` runs before candidate bytes are applied. The candidate is then
applied, protected files are restored from the host snapshot, outbound network
access is blocked, and gate commands collect raw evidence. Only the host
plugins classify that evidence.

An accepted candidate is published from the retained host snapshot. Harness
does not recollect the live agent workspace after a pass.

## Required Environment

```bash
export DAYTONA_API_KEY="<daytona-key>"
export DAYTONA_API_URL="http://localhost:3000/api" # optional default
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
export ANTHROPIC_AUTH_TOKEN="<short-lived-model-token>"
export ANTHROPIC_BASE_URL="<approved-model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"
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

`HARNESS_DAYTONA_AGENT_SNAPSHOT` is selected by the host control plane before
the agent sandbox is created. Claude runs fail before sandbox creation when it
is missing. Gate sandboxes never inherit this Snapshot and are always created
without Claude or model credentials.

For a remote Daytona control plane, set `DAYTONA_API_URL` to the remote API
endpoint and provide the key through the shell environment. Do not commit API
keys or model tokens to this repository.

## Agent Image And Snapshot

Claude Code is no longer installed during `harness run`. The agent image is
built once with pinned tool versions:

```text
Node.js: 22.14.0
Claude Code: 2.1.145
Docker image: harness-daytona-claude:2.1.145-r2
Registry image: registry:6000/harness/harness-daytona-claude:2.1.145-r2
Daytona Snapshot: harness-agent-claude-2.1.145-r2
```

Build, push, register, activate, and verify the Snapshot:

```bash
source ~/.zshrc
npm run snapshot:agent
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-2.1.145-r2"
```

`npm run snapshot:agent` builds the image inside the Daytona runner container,
pushes it to the runner-local registry, creates or activates the immutable
Daytona Snapshot, starts a temporary sandbox from that Snapshot, and verifies:

```text
/usr/local/bin/node
/usr/local/bin/npm
/usr/local/bin/npx
/usr/local/bin/claude
/usr/bin/bash
```

The script prints the final `export HARNESS_DAYTONA_AGENT_SNAPSHOT=...` line
after verification succeeds.

Upgrade requires a new revision. Change the pinned constants and publish `r2`
or later; do not overwrite `r1`. Rollback is selecting the previous Snapshot
value in the host environment.

Useful diagnosis commands:

```bash
docker exec daytona-runner-1 docker images \
  'registry:6000/harness/harness-daytona-claude'
npm run snapshot:agent
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

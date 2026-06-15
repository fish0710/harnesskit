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
npm run test:daytona
```

The integration test creates a temporary Git worktree, uses one Claude agent
sandbox, validates the result in a separate gate sandbox, publishes the exact
passing bytes, and deletes the sandboxes.

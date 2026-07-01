# harnesskit

Harnesskit is a TypeScript/Node.js CLI that combines a contract-based Gate
engine with an agent execution loop. It is designed for automated code changes
where an implementation agent may mutate files, but the decision to pass,
retry, block, or publish stays in the host process.

The default production model is:

```text
host control plane
  -> persistent Daytona Agent sandbox runs Claude or a custom command agent
  -> fresh Daytona Gate sandbox validates every candidate attempt
  -> host GateCore classifies evidence, records runs, and publishes exact bytes
```

The main safety invariant is:

> Sandboxes produce files and raw evidence. The host owns contracts, verdicts,
> retry/escalation decisions, and publication.

## Requirements

- Node.js `>=20` for local development.
- Daytona credentials for `--driver claude`, `--driver command`, Gate preflight,
  runtime snapshots, and real integration tests.
- Anthropic-compatible model credentials for `--driver claude`.

Install and verify the source checkout:

```bash
npm ci
npm run build
npm run check
node dist/src/cli.js help
```

If the package is installed or linked as a bin, replace `node dist/src/cli.js`
with `harness`.

## Command Surface

```bash
# Project setup and planning
harness create [dir] [--force]
harness plan "<task>"

# Local validation
harness contract validate contracts
harness contract freeze contracts/smoke.boot.yaml
harness check --dir contracts --config harness.config.json
harness gate premerge --dir contracts
harness preflight gate --dir contracts --config harness.config.json
harness explain <contractId> --dir contracts
harness status

# Agent loops
harness run "implement the task" --driver scaffold
harness run "implement the task" --driver command --agent-cmd "./tools/agent.sh"
harness run "implement the task" --driver claude --max-attempts 3 --max-ms 6000000
harness fix --driver claude --max-attempts 3

# Review and run records
harness review --dir contracts
harness review --resolve <contractId> --option <optionId> --by <name> --reason "..."
harness runs list --json
harness runs show <runId> --json
harness runs resume <runId> --max-attempts 2
```

Exit codes:

```text
0 = pass / ready
1 = fail / error / escalated
2 = blocked, waiting for human review
```

## Core Concepts

### Contracts And Plugins

Contracts live in `contracts/*.yaml|json`. A file may contain one contract or an
array of contracts. Each contract has an `id`, a `type`, and type-specific
fields.

Built-in contract types:

| Type | Purpose |
|---|---|
| `command` | Run a command and compare the exit code. |
| `boot` | Run a command and enforce startup duration. |
| `http` | Send an HTTP request and assert status/body. |
| `structure` | Run a static analysis tool such as eslint or dependency-cruiser. |
| `invariant` | Run host-provided property tests. |
| `review` | Stop for a structured human decision. |

Plugin results distinguish:

```text
pass          ran and passed
fail          ran and found a product violation
error         did not produce trustworthy evidence
needs_review  requires a human verdict
```

`GateCore` aggregates results into `pass`, `fail`, or `blocked`. Unknown plugin
types and untrusted evidence fail closed as `error`.

### Sandbox Policy

`harness.config.json` controls what the agent can see, mutate, and publish:

```json
{
  "baseline": ["smoke.boot"],
  "rules": [
    { "when": ["src/**"], "select": ["cli.help-exits-zero"] }
  ],
  "sandbox": {
    "candidateRoots": ["src", "package.json", "package-lock.json"],
    "readOnlyPaths": ["AGENTS.md", "docs/specs", "docs/plans", "docs/reference"],
    "protectedPaths": ["contracts", ".harness", "harness.config.json", ".github/workflows", "CODEOWNERS", "test/gates"],
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

Path semantics:

| Field | Agent visibility | Publishable | Intended use |
|---|---:|---:|---|
| `candidateRoots` | yes | yes | Source files the agent may change. |
| `readOnlyPaths` | yes | no | Specs, plans, runtime references, task context. |
| `protectedPaths` | no | no | Contracts, verdicts, CI, trusted gate runners, Harness state. |

Path classification is `protected -> read-only -> candidate -> ignored`. If a
read-only file changes, candidate collection fails before Gate execution.

### Drivers

| Driver | Behavior |
|---|---|
| `scaffold` | Default dry driver. It exercises the loop and gates but does not generate code. |
| `command` | Runs a custom agent command in Daytona. Requires `--agent-cmd`. |
| `claude` | Runs Claude Code in a persistent Daytona Agent sandbox. |

`command` and `claude` do not silently fall back to host execution. Missing
Daytona configuration stops before an agent runs.

### RunStore And Ledgers

Harness writes durable run records before agent work starts:

```text
.harness/runs/<runId>.json
```

RunStore v3 records include repo identity, task metadata, selected contracts,
attempts, sandbox ids, logs, final Gate report, publication metadata, and
observability paths. `kind` is one of `single`, `series`, or `series-task`.

Verbose runs also write:

```text
.harness/runs/<runId>.log.jsonl
```

Configured task series progress lives in:

```text
.harness/series/<series-id>.json
```

RunStore is the audit/diagnostic record. The series ledger is the resume/skip
and optional commit state for configured task series.

## Common Workflows

### Initialize A Target Project

```bash
harness create .
```

This writes the standard Harness skeleton:

```text
AGENTS.md
harness.config.json
contracts/
docs/
docs/reference/harness-runtime.md
CODEOWNERS
.github/workflows/harness-gate.yml
.harness/
```

Existing files are not overwritten unless `--force` is used. After scaffolding,
edit `contracts/*.yaml` and `harness.config.json`.

### Validate Without An Agent

```bash
harness check --dir contracts --config harness.config.json
harness check --dir contracts --changed src/foo.ts,package.json
harness check --dir contracts --base-url http://127.0.0.1:3000
harness check --dir contracts --json
```

`harness check` executes locally. `harness preflight gate` creates a short-lived
Daytona Gate sandbox, uploads the current host workspace, runs `gateSetup`, and
executes selected remote contracts through host-owned GateCore:

```bash
harness preflight gate --dir contracts --config harness.config.json --json
```

Preflight separates readiness errors from product-red failures. Missing tools,
bad `nvm` usage, Gate-side `claude`, setup failures, evidence errors, and cleanup
errors block agent startup. Product assertion failures can still be handed to
the agent.

### Run Claude In Daytona

Required environment:

```bash
export DAYTONA_API_KEY="<daytona-key>"
export DAYTONA_API_URL="http://localhost:3000/api"

export ANTHROPIC_AUTH_TOKEN="<short-lived-model-token>"
export ANTHROPIC_BASE_URL="<approved-model-endpoint>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<model>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<model>"

# Optional. Defaults derive ANTHROPIC_MODEL from SONNET and
# ANTHROPIC_REASONING_MODEL from OPUS.
export ANTHROPIC_MODEL="<model>"
export ANTHROPIC_REASONING_MODEL="<model>"

# Optional snapshot overrides.
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-latest"
export HARNESS_DAYTONA_GATE_SNAPSHOT="harness-gate-runtime-latest"
```

Run:

```bash
harness run "实现一个健康检查接口" --driver claude --max-attempts 3 --max-ms 6000000
```

Each run:

- creates a host run record first;
- creates one persistent Agent sandbox;
- runs Gate readiness preflight before agent work;
- feeds Gate diagnostics back to the same Agent sandbox;
- uses a fresh Gate sandbox per remote Gate attempt;
- publishes only the exact candidate bytes evaluated by the passing Gate.

Use `--verbose` or `HARNESS_VERBOSE=1` for live structured diagnostics:

```bash
harness run "实现任务" --driver claude --verbose
```

Non-verbose Claude runs still render safe live summaries for Claude text, tool
use, progress, and final result.

### Run A Custom Command Agent

```bash
harness run "实现一个健康检查接口" \
  --driver command \
  --agent-cmd "./tools/my-agent.sh"
```

Harness injects:

```text
HARNESS_TASK
HARNESS_FEEDBACK
```

The command agent still runs under Daytona isolation. It must produce files
under `candidateRoots`.

### Review Gates

`type: review` contracts produce `blocked` until a human records a verdict:

```bash
harness review --dir contracts
harness review --resolve product.behavior-change \
  --option regression \
  --by zhongyy40 \
  --reason "缺少接口变更批准"
```

Verdicts are stored under `.harness` and used by later checks.

### Configured Task Series

If `harness.config.json` contains `tasks`, running `harness run` without a task
string executes the configured series:

```json
{
  "series": { "id": "order-refactor" },
  "taskDefaults": {
    "gate": { "contracts": ["smoke.boot"], "stage": "premerge" }
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

```bash
harness run --driver claude --max-attempts 3
```

Completed tasks with matching task hashes are skipped before child run creation,
Agent creation, Gate creation, and preflight. `ready_to_commit` tasks complete
or confirm their commit before being marked completed. `blocked`, `escalated`,
`error`, and hash drift stop for human handling.

Auto commit stages only the source files that were actually published by the
passing Gate. `.harness` run records and series ledgers are not included.

### Retained Sandbox Resume

For Daytona Claude runs with `sandbox.retainOnFailure: true`, resume is explicit:

```bash
harness runs resume <runId> --max-attempts 2
```

Resume is conservative:

- supports retained `daytona(claude)` escalated runs and interrupted running
  Claude runs;
- requires matching current `HEAD`;
- requires the current source worktree to be clean outside `.harness` runtime
  records;
- attaches by `agentSandboxId`;
- recovers `claudeSessionId` from `claudeStreamPath` when needed;
- runs Gate first before another Claude turn;
- publishes and deletes the retained sandbox if Gate passes.

Historical runs that were dirty only because Harness-owned setup files were
untracked can be resumed with:

```bash
harness runs resume <runId> --allow-harness-dirty-source --max-attempts 2
```

That flag still rejects product source, package, app page/component, and build
output changes.

## Daytona Runtime Snapshots

Default snapshots:

| Purpose | Snapshot | Contents |
|---|---|---|
| Agent | `harness-agent-claude-latest` | Node.js 22.14.0, npm/npx, Claude Code 2.1.145, `/usr/bin/bash` |
| Gate | `harness-gate-runtime-latest` | Node.js 22.14.0 default, npm/npx, python3, curl, `/usr/bin/bash`, preinstalled Node 14.21.3/npm 6.14.18 through nvm, no `claude` |

Maintenance commands:

```bash
npm run snapshot:agent
npm run snapshot:gate
npm run snapshot:runtime
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:runtime
```

The Gate snapshot provides runtime dependencies for evidence collection. It
does not change the trust boundary: Gate receives no model credentials,
Langfuse credentials, Agent Snapshot, or Claude binary.

## Observability

Daytona Claude runs are observable through three layers:

1. Host RunStore: `.harness/runs/<runId>.json`.
2. Optional verbose JSONL: `.harness/runs/<runId>.log.jsonl`.
3. Daytona volume artifacts:

```text
volume: harness-claude-observability
mount in Agent sandbox: /harness-observability
volume subpath: runs/<runId>
Claude native state while running: /home/daytona/.claude
Copied native state after command: /harness-observability/.claude
Raw stream transcript: /harness-observability/attempt-<n>/claude-stream.jsonl
```

Harness does not set `CLAUDE_CONFIG_DIR` for the Daytona Claude command. Claude
writes native state to sandbox-local `/home/daytona/.claude`; Harness copies it
to the mounted run root after each command. The raw `stream-json` transcript is
also written directly to the mounted run root and recorded as
`attempts[].claudeStreamPath`.

Claude retries use strong resume. The first attempt must yield a safe session
id; later Gate-fail retries run `claude --resume <sessionId>` in the same Agent
sandbox. Missing or inconsistent resume state fails closed.

`agent.command.heartbeat` is a liveness signal only. It proves the remote
Claude command promise is still pending; it does not prove semantic progress.
The Claude main command has no fixed 20-minute Harness timeout, but the overall
run budget `--max-ms` still applies.

Run records and logs can contain sensitive operational data. Treat `.harness`
as an audit directory, not as public telemetry.

## Examples

| Example | Purpose |
|---|---|
| [examples/serial-task-series](examples/serial-task-series/README.md) | Local command-driver configured series without Daytona credentials. |
| [examples/resume-health-port](examples/resume-health-port/README.md) | Daytona Claude feedback retry and strong resume against an HTTP contract. |
| [examples/daytona-cli-tdd](examples/daytona-cli-tdd/README.md) | Daytona Claude implementation of a CLI through protected command tests. |
| [examples/daytona-task-series](examples/daytona-task-series/README.md) | Daytona Claude configured task series with parent/child run records. |

The Daytona examples are intentionally checked in as product-red baselines. Run
them in a disposable copy or branch if you want to preserve the initial state.

## Troubleshooting And Notes

- `harness run` did not change files: the default driver is `scaffold`; pass
  `--driver claude` or `--driver command`.
- `--driver command` requires `--agent-cmd`.
- Daytona commands require `DAYTONA_API_KEY`; Claude also requires the Anthropic
  environment variables listed above.
- Do not commit Daytona keys, model tokens, Langfuse secrets, or run artifacts
  containing sensitive prompts.
- If a local proxy is stale, clear it or make sure Daytona hosts bypass it:

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="localhost,127.0.0.1,proxy.localhost,.localhost"
```

- In Gate sandboxes, `127.0.0.1` means the Gate sandbox, not the host. Start the
  service in `gateSetup` before an HTTP contract checks it.
- Do not run `claude` from Gate setup or contracts. Gate must remain agent-free.
- Bare `nvm use` in Gate setup usually fails. Source `/usr/local/nvm/nvm.sh`
  first; Node 14.21.3 is preinstalled for legacy projects.
- The interactive Agent shell project path is
  `/home/daytona/workspace/candidate`. `/workspace/candidate` is Harness'
  logical remote root used at the SDK boundary.
- Keep dependency manifests and build configs out of `candidateRoots` unless the
  task explicitly changes dependencies. If Gate setup consumes a manifest, the
  Agent and Gate setup should agree on the same project root.
- `readOnlyPaths` are visible context, not publishable outputs. Use
  `protectedPaths` for hidden host-owned assets.
- Harness does not merge, push, approve pull requests, or bypass CI.

## Current Documentation Map

| Document | Use |
|---|---|
| [docs/usage.md](docs/usage.md) | Day-to-day CLI manual. |
| [docs/architecture/daytona-sandbox-gate.md](docs/architecture/daytona-sandbox-gate.md) | Current Agent/Gate trust-boundary architecture. |
| [docs/architecture/gate-plugin-guide.md](docs/architecture/gate-plugin-guide.md) | Contract schema and plugin authoring guide. |
| [docs/architecture/daytona-langfuse-observability.md](docs/architecture/daytona-langfuse-observability.md) | Langfuse/OpenTelemetry versus Daytona artifact observability. |
| [docs/daytona-local-claude-code-runbook.md](docs/daytona-local-claude-code-runbook.md) | Daytona/Claude runtime, snapshots, resume, and artifact runbook. |
| [plugins/harness-prep](plugins/harness-prep/skills/harness-prep/SKILL.md) | Codex plugin skill for preparing Harness projects and runs. |
| [ci/branch-protection.md](ci/branch-protection.md) | Suggested CI/branch protection integration. |

## Archive Index

Each archive directory contains a README plus, where applicable, a commit ledger
and verification record. Newer archives supersede older path or behavior details
when they describe the same subsystem.

| Date | Archive | What It Captures |
|---|---|---|
| 2026-06-15 | [Daytona Sandbox Gate](docs/archive/2026-06-15-daytona-sandbox-gate/README.md) | Initial split between persistent Agent sandbox, fresh Gate sandbox, host-owned evidence classification, and exact-byte publication. |
| 2026-06-16 | [Daytona Claude Image / PTY / CLI Validation](docs/archive/2026-06-16-daytona-claude-image-pty-cli-validation/README.md) | Pinned Claude Agent image, r2 Snapshot, toolbox/PTY URL fixes, and real CLI validation. |
| 2026-06-16 | [Daytona Latest Runtime Gate](docs/archive/2026-06-16-daytona-latest-runtime-gate/README.md) | Stable `harness-agent-claude-latest` and `harness-gate-runtime-latest`, Gate without Claude, HTTP evidence marker. |
| 2026-06-17 | [Daytona Claude Observability Persistence](docs/archive/2026-06-17-daytona-claude-observability-persistence/README.md) | First artifact persistence design: run manifest and observability volume. Later transcript path details are superseded by the 2026-06-22 archive. |
| 2026-06-17 | [MiniProgram Host Gate](docs/archive/2026-06-17-miniprogram-host-gate/README.md) | `type: miniprogram`, host-local candidate materialization, DevTools automation, and templates. |
| 2026-06-17 | [Serial Tasks Auto Commit](docs/archive/2026-06-17-serial-tasks-auto-commit/README.md) | Configured task series, ledger skip/resume rules, task-specific Gate selection, optional auto commit. |
| 2026-06-18 | [Harness Prep Plugin](docs/archive/2026-06-18-harness-prep-plugin/README.md) | Local Codex plugin/skill for preparing specs, contracts, configs, runs, review, and observability. |
| 2026-06-18 | [Unified RunStore](docs/archive/2026-06-18-unified-runstore/README.md) | RunStore v3 records for single runs, series parents, and series-task children. |
| 2026-06-22 | [Daytona Claude Transcript Persistence](docs/archive/2026-06-22-daytona-claude-transcript-persistence/README.md) | Current transcript mechanism: no `CLAUDE_CONFIG_DIR`, local `/home/daytona/.claude`, copied `.claude`, raw `claude-stream.jsonl`. |
| 2026-06-22 | [Gate Node 14 Runtime Snapshot](docs/archive/2026-06-22-gate-node14-runtime/README.md) | Gate latest with Node 22 default plus preinstalled Node 14.21.3/npm 6 for legacy `nvm use` setup. |
| 2026-06-23 | [Claude Command Heartbeat](docs/archive/2026-06-23-claude-command-heartbeat/README.md) | Host-side liveness heartbeat while the remote Claude command is pending. |
| 2026-06-23 | [Claude Command Timeout Removal](docs/archive/2026-06-23-claude-command-timeout-removal/README.md) | Removal of the fixed 20-minute timeout from the main Claude command while preserving bounded setup/Gate timeouts and run budgets. |
| 2026-06-23 | [Daytona Agent Workspace Path](docs/archive/2026-06-23-daytona-agent-workspace-path/README.md) | Clarifies `/home/daytona/workspace/candidate` for interactive shells versus Harness logical `/workspace/candidate`. |
| 2026-06-23 | [Explicit Verbose Run Logging](docs/archive/2026-06-23-explicit-verbose-run-logging/README.md) | `--verbose`, `HARNESS_VERBOSE=1`, JSONL diagnostic logs, shared redaction, executable bin fix. |
| 2026-06-23 | [Harness Prep Serial Resume](docs/archive/2026-06-23-harness-prep-serial-resume/README.md) | Skill guidance for interrupted series recovery, dependency manifest boundaries, and setup-input protection. |
| 2026-06-23 | [Harness Series Status And Skill Refresh](docs/archive/2026-06-23-harness-series-status-skill-refresh/README.md) | Visible completed-task skips, v3 RunStore-backed status, and refreshed harness-prep guidance. |
| 2026-06-23 | [MiniProgram Gate Stability](docs/archive/2026-06-23-miniprogram-gate-stability/README.md) | Managed DevTools protocol readiness, host-local preflight doctor, cleanup, and runner anti-pattern guidance. |
| 2026-06-23 | [Read-Only Agent Context](docs/archive/2026-06-23-read-only-agent-context/README.md) | `sandbox.readOnlyPaths` as a first-class visible-but-not-publishable context boundary. |
| 2026-06-24 | [Gate Runtime Clean Build Guidance](docs/archive/2026-06-24-gate-runtime-clean-build-guidance/README.md) | Scaffolded runtime reference docs and clean-build-as-final-task guidance. |
| 2026-06-24 | [MiniProgram Artifact-first Defaults](docs/archive/2026-06-24-miniprogram-artifact-first-defaults/README.md) | Default mini-program workflow: agent publishes built artifact, behavior gate consumes it, clean rebuild is optional separate contract. |
| 2026-06-24 | [MiniProgram Automator Toolchain](docs/archive/2026-06-24-miniprogram-automator-toolchain/README.md) | Harness-owned `miniprogram-automator` dependency and `NODE_PATH` injection for trusted runners. |
| 2026-06-25 | [Daytona Claude Examples](docs/archive/2026-06-25-daytona-claude-examples/README.md) | Real Daytona/Claude examples for feedback retry, CLI TDD, and configured task series. |
| 2026-06-25 | [Preflight Host-Local Review Ledger](docs/archive/2026-06-25-preflight-hostlocal-review-ledger/README.md) | Static detection of mini-program automation mis-modeled as command contracts and blocked-review series resume after verdicts. |
| 2026-06-30 | [Claude Live Summary](docs/archive/2026-06-30-claude-live-summary/README.md) | Readable non-verbose live summaries for Claude stream text, tool, progress, and result events. |
| 2026-06-30 | [Retained Sandbox Resume](docs/archive/2026-06-30-retained-sandbox-resume/README.md) | Explicit retained Daytona Agent sandbox resume, Gate-first recovery, stream session recovery, and Harness-only dirty-source rescue. |

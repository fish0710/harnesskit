# Run Supervision

Use this before starting `harness run` and while keeping the user informed.

## Reliability Basis

Harness flow is host controlled: Agent attempt -> Gate attempt -> feedback/retry -> publication or stop. `pass` publishes gate-evaluated candidate bytes; `blocked` stops for `harness review`; `fail` or `error` feeds diagnostics back until budget or escalation. Configured task series can auto-commit per gate-approved publication.

## Start Sequence

1. Confirm the spec, plan, contracts, config, and sandbox environment.
2. Confirm `sandbox-snapshots.md` has been considered for setup commands and Gate tool availability.
3. Run preflight validation:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness preflight gate --dir contracts --config harness.config.json --json
harness status --dir contracts
```

4. If preflight has `error`, fix config/setup. Do not start Agent.
5. If preflight has expected `fail`, explain that the current implementation is red and the Agent will try to satisfy it.
6. If preflight has `blocked`, resolve or intentionally keep the review gate for runtime.
7. If `harness preflight gate` reports readiness errors, fix config/setup/toolchain assumptions. Daytona-backed `harness run` will enforce the same readiness barrier before Agent creation; do not treat the error as an implementation task.
8. Start one of:

```bash
harness run --driver claude --max-attempts 3
harness run "<confirmed task>" --driver claude --max-attempts 3
harness run "<confirmed task>" --driver command --agent-cmd "<runner>"
```

## Progress Updates

Report by state, not by optimism:

```text
Harness has started. It is running task <id/task>.
Agent sandbox: pending until manifest records it.
Gate contracts: <contract ids>.
I will stop and ask you before resolving any review gate.
```

When a run record exists:

```bash
harness runs list --json
harness runs show <runId> --json
```

Explain each attempt:

- Agent sandbox id: where the implementation agent worked.
- Gate sandbox ids: where validation ran.
- Gate outcome: pass/fail/blocked.
- Claude session/resume id: whether retry continued the same conversation.

Use `runstore-observability.md` for compact RunStore extraction commands. Current records are schema v3 and include `kind`, `selectedContracts`, `logs`, `report`, `publication`, and series parent/child links.

### Claude Command Quiet Periods

For `--driver claude`, the phase from `agent.command.start` to
`agent.command.end` can be quiet. During that period, no Claude command output can be normal
and the `claude-stream.jsonl` file may stay empty until the command exits.

Use `agent.command.heartbeat` as the liveness signal:

Heartbeat is a liveness signal only; it does not prove semantic Claude progress.

- If heartbeat events continue, the Agent command is active. Do not call the
  sandbox stuck only because stdout, terminal output, or stream bytes are quiet.
- If the heartbeat stops unexpectedly, the CLI exits, the command times out, or
  RunStore records `status: "error"`, switch to `blocker-analysis.md`.
- If the wait is long but heartbeat continues, say that Harness is still waiting
  on the remote Claude command and keep polling the run record.

## Outcome Handling

### `ready_for_mr`

Say:

```text
Harness gate passed and published the evaluated candidate bytes to the host workspace.
This is not the same as merge approval. Check git status and CI next.
```

Then run:

```bash
git status --short
harness status --dir contracts
```

For single-task runs, do not claim a git commit exists unless `git log` shows one. For configured series, check `.harness/series/<series-id>.json` and git log because auto commit may be enabled.

### `blocked`

Say:

```text
Harness stopped because a review contract needs your decision.
No automatic retry should continue until this is resolved.
```

Then run:

```bash
harness review --dir contracts
```

Explain options and record only the user's decision.

### `escalated`

Say:

```text
Harness stopped because retry budget, repeated wall, publication conflict, or another stop condition was reached.
I will inspect the run manifest and gate diagnostics before proposing a fix.
```

Then use `blocker-analysis.md`.

### `error` Run Record

Treat this as infrastructure/config failure until proven otherwise. Check missing env, Daytona API, snapshot, volume mount, setup commands, and malformed config.
If the error says a command is missing, compare it with `sandbox-snapshots.md` before blaming the implementation agent. Common absent tools are `git`, `pnpm`, `yarn`, `bun`, and `claude` in Gate.

## Series Supervision

Configured task series run with no positional task:

```bash
harness run --driver claude --max-attempts 3
```

Check the ledger:

```bash
harness runs list --series-id <series-id> --json
ls .harness/series
node -e 'const fs=require("fs"); const p=process.argv[1]; const r=JSON.parse(fs.readFileSync(p,"utf8")); console.log(JSON.stringify({seriesId:r.seriesId,status:r.status,tasks:r.tasks}, null, 2))' .harness/series/<series-id>.json
```

Explain:

- RunStore parent `kind=series`: audit summary and child run ids.
- RunStore child `kind=series-task`: task-specific Gate report, logs, selected contracts, Agent/Gate ids.
- Series ledger: resume, task hash, ready-to-commit, commit state.
- `completed`: already done; rerun should skip matching completed tasks.
- `running`: interrupted or active task; inspect latest run record.
- `ready_to_commit`: gate passed but commit step needs completion.
- `blocked`/`escalated`/`error`: stop and inspect that task before continuing.

## Do Not

- Do not resolve `review` gates without explicit user decision.
- Do not say "merged" when only `ready_for_mr` happened.
- Do not say "committed" for single-task runs unless git history confirms it.
- Do not keep retrying after repeated escalation without inspecting root cause.

# Run Supervision

Use this before starting `harness run` and while keeping the user informed.

## Reliability Basis

Harness flow is host controlled: Agent attempt -> Gate attempt -> feedback/retry -> publication or stop. `pass` publishes gate-evaluated candidate bytes; `blocked` stops for `harness review`; `fail` or `error` feeds diagnostics back until budget or escalation. Configured task series can auto-commit per gate-approved publication.

## Start Sequence

1. Confirm the spec, plan, contracts, config, and sandbox environment.
2. Confirm `sandbox-snapshots.md` has been considered for setup commands and Gate tool availability.
3. Run host validation:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness status --dir contracts
```

Use `--changed fileA,fileB` when the task has a narrow file scope. Avoid a full
`harness check` when it would run unrelated slow contracts.

4. Optional: run `harness preflight gate --dir contracts --config harness.config.json --json` only when you need early Gate sandbox readiness feedback before the actual run. Daytona-backed `harness run` performs the same readiness barrier before Agent creation, so this manual command is deliberately duplicate work.
5. If manual preflight reports readiness errors, fix config/setup/toolchain assumptions. Do not treat the error as an implementation task.
6. If host check has expected `fail`, explain that the current implementation is red and the Agent will try to satisfy it.
7. If host check has `blocked`, resolve or intentionally keep the review gate for runtime.
8. For configured series, inspect the series ledger before expecting new work:

```bash
find .harness/series -maxdepth 1 -type f -print
```

If the relevant task is already `completed` with the same `taskHash`, a no-task
`harness run` will skip it before creating a child run, Agent sandbox, Gate
sandbox, or built-in preflight.

If a previous series stopped mid-run, recover the original series. Do not
change `series.id` or delete `.harness` unless the user explicitly asks for a
full rerun; a new id creates a new ledger and reruns completed tasks.
9. Start one of:

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
Do not describe missing or unchanged `claudeStreamBytes` as proof that Claude
Code produced no sandbox output. That field only reflects host-side parsed
stream progress recorded in RunStore; Claude may still be producing output that
is visible inside the sandbox or not yet folded into a progress event.

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
- Series ledger: resume, task hash, ready-to-commit, commit state. This is the authority for skip/resume/commit progress; RunStore is the historical audit log and can retain old error or escalated child runs.
- `completed`: already done; rerun should skip only when the current `taskHash` matches.
- `pending`/`running`: interrupted or active task; inspect latest run record before rerunning.
- `ready_to_commit`: gate passed but commit step needs completion.
- `blocked`/`escalated`/`error`: stop and inspect that task before continuing.

### Interrupted Series Recovery

When a configured serial task fails partway through, restore the original series
instead of bypassing the stop state with a new `series.id`.

Recovery flow:

1. Read `.harness/series/<series-id>.json`.
2. Confirm the current `harness.config.json` still uses the same `series.id`.
3. Preserve completed task entries exactly, including `status: "completed"`,
   original `taskHash`, `commit`, `runRecord`, and timestamps. Do not rewrite a
   completed task hash to make it match new config.
4. Diagnose and fix the root cause in config, setup, contracts, environment, or
   implementation scope.
5. For only the stopped task, remember that `blocked`, `escalated`, and `error`
   stop immediately on rerun. After fixing the root cause, a host operator may
   restore that task to `pending` or `running` to rerun it under the same series.
6. Rerun with the original `series.id` and confirm stdout shows:

```text
[n/m] <task> · skipped completed (taskHash unchanged)
```

Only after the completed tasks skip should Harness enter the failed task.

If the user explicitly asks for a full rerun, say first that completed tasks will
execute again and may add time, token, sandbox, and CI cost. Then use a new
series id or clear the ledger only with that explicit approval.

If a rerun prints `series completed` after skipping completed tasks, do not
interpret the lack of a new child run or Gate preflight as a no-op bug. It means
the ledger already satisfied the configured task hash. Check `autoCommit.enabled`
before claiming a commit exists; `false` means Harness only published candidate
bytes and updated the ledger.

## Do Not

- Do not resolve `review` gates without explicit user decision.
- Do not say "merged" when only `ready_for_mr` happened.
- Do not say "committed" for single-task runs unless git history confirms it.
- Do not keep retrying after repeated escalation without inspecting root cause.
- Do not change `series.id` to get past a stopped serial task.

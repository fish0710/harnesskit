# RunStore Observability

Use this whenever you need to answer "what is Harness doing now?", inspect a past run, connect a series parent to its tasks, or locate Claude artifacts.

## Reliability Basis

Current Harness writes durable v3 RunStore records for `harness run` under:

```text
.harness/runs/<runId>.json
```

The supported query surface is:

```bash
harness runs list --json
harness runs show <runId> --json
harness runs list --task-id <taskId> --json
harness runs list --series-id <seriesId> --json
```

When using the source checkout CLI:

```bash
node dist/src/cli.js runs list --json
node dist/src/cli.js runs show <runId> --json
```

Use raw file reads only as a fallback for older Harness versions or when the CLI cannot run.

## v3 Record Shape

Important fields:

- `schemaVersion`: `3` for current RunStore records.
- `kind`: `single`, `series`, or `series-task`.
- `status`: `running`, `completed`, or `error`.
- `outcome`: `ready_for_mr`, `blocked`, `escalated`, `completed`, or `error` when known.
- `repo`: repo root, git root, branch, HEAD, dirty flag.
- `task`: description plus optional `taskId`, `seriesId`, `index`, `total`.
- `driver`: `scaffold`, `daytona(command)`, `daytona(claude)`, or `series(...)`.
- `selectedContracts`: contract ids selected for the run.
- `attempts`: Agent sandbox ids, Gate sandbox ids, Claude session ids, resume ids, Claude stream path, exit codes, gate outcome.
- `events`: host-side observation timeline.
- `logs`: run loop log lines.
- `report`: final Gate report.
- `publication`: published candidate files or publication conflict.
- `summary`, `action`, `errorReason`: final decision context.
- `children`: only on `kind: "series"` parent records.

Treat `.harness/runs` as sensitive operational data. It can include prompts, diagnostics, event payloads, paths, and final Gate reports.

## Single Run Lookup

Find the newest run:

```bash
harness runs list --json | node -e 'const fs=require("fs"); const runs=JSON.parse(fs.readFileSync(0,"utf8")); console.log(runs[0]?.runId ?? "no-runs")'
```

Show a compact status:

```bash
harness runs show <runId> --json | node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(0,"utf8")); console.log(JSON.stringify({runId:r.runId,kind:r.kind,status:r.status,outcome:r.outcome,task:r.task,driver:r.driver,selectedContracts:r.selectedContracts,summary:r.summary,action:r.action,errorReason:r.errorReason}, null, 2))'
```

Show attempt correlation:

```bash
harness runs show <runId> --json | node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(0,"utf8")); console.log(JSON.stringify((r.attempts||[]).map(a=>({attempt:a.attempt,agentSandboxId:a.agentSandboxId,gateSandboxIds:a.gateSandboxIds,gateOutcome:a.gateOutcome,claudeSessionId:a.claudeSessionId,resumedFromSessionId:a.resumedFromSessionId,exitCode:a.exitCode})), null, 2))'
```

## Series Lookup

A configured series creates:

- one `kind: "series"` parent run;
- one `kind: "series-task"` child run per configured task that starts or fails during task setup;
- a separate `.harness/series/<series-id>.json` ledger for resume/commit progress.

Use RunStore for audit and diagnosis. Use the series ledger for resume, task
hash, ready-to-commit, and auto-commit state. Do not mix these surfaces:
`.harness/runs` keeps historical error or escalated runs forever, while
`.harness/series/*.json` decides whether a task is skipped, resumed, committed,
or stopped.

Find a series parent and children:

```bash
harness runs list --series-id <seriesId> --json
harness runs show <parentRunId> --json
```

Interpret:

- Parent `children[]` is a summary index: child run id, task id, index, status, outcome.
- Child `parentRunId` links back to the parent.
- Child `task.taskId`, `task.seriesId`, `task.index`, and `task.total` identify the configured task.
- Parent `summary` is aggregated from series progress, not a replacement for each child Gate report.
- If all configured tasks are already `completed` with matching hashes, a new
  series parent can complete without creating any child run. In that path
  Harness skips before Agent creation, Gate sandbox creation, and built-in Gate
  preflight. Treat this as expected resume behavior.

If a no-task `harness run` cannot parse config or cannot find a configured series, there may be no RunStore record because Harness does not know a valid series identity yet. Once a series parent exists, later parent or child setup failures should be recorded as `status: "error"`.

## Claude Artifact Correlation

RunStore stores indexes and audit metadata. It does not copy `.claude` session files into `.harness/runs`.

For `--driver claude`, use:

- `runId` -> Daytona volume subpath `runs/<runId>`;
- `observability.volumeName` -> usually `harness-claude-observability`;
- `observability.mountPath` -> usually `/harness-observability`;
- `attempts[].agentSandboxId` -> Agent sandbox used for that attempt;
- `attempts[].claudeSessionId` and `resumedFromSessionId` -> session continuity evidence;
- `attempts[].gateSandboxIds` -> fresh validation sandboxes;
- `attempts[].claudeStreamPath` -> mounted path for the raw `stream-json` transcript, usually `/harness-observability/attempt-<n>/claude-stream.jsonl`.
- `attempts[].claudeStreamBytes` -> host-side parsed stream progress from
  `agent.command.progress`; this is not the authoritative remote file size or a
  complete measure of sandbox-visible Claude output.
- `attempts[].commandLastHeartbeatAt` -> host timestamp of the latest
  `agent.command.heartbeat` folded into the attempt.
- `attempts[].commandLastHeartbeatElapsedMs` -> elapsed time reported by the
  latest heartbeat while Harness was waiting on the Agent command.

While Claude runs, native state is sandbox-local:

```text
/home/daytona/.claude
```

Before Agent cleanup, Harness copies that directory into the mounted run volume:

```text
/harness-observability/.claude
```

This copy is not to the Harness host machine and not into `.harness/runs`; it is
inside the Daytona observability volume. RunStore stores the correlation fields
needed to mount and inspect that volume later.

In the durable volume, the run is scoped by:

```text
runs/<runId>
```

Use absolute mounted paths when calling Daytona FS APIs after remounting the volume.

After remounting `runs/<runId>` at `/harness-observability`, inspect:

```text
/harness-observability/.claude/projects/<project-key>/<claudeSessionId>.jsonl
/harness-observability/attempt-<n>/claude-stream.jsonl
```

Do not create an inspection sandbox that mounts the volume at
`/home/daytona/.claude`; direct HOME mounts can cause Claude Code native JSONL
to contain only startup events. Mount the run root at `/harness-observability`
and read the copied `.claude` tree.

## Diagnosis Rules

- `status: "error"` means Harness setup or infrastructure failed; inspect `errorReason` before blaming implementation.
- `outcome: "blocked"` means a review contract needs user verdict; use `harness review`.
- `outcome: "escalated"` means retry budget, repeated wall, context/budget, Agent failure, or publication conflict; inspect `action`, `report`, `logs`, and `events`.
- `outcome: "ready_for_mr"` means gate-approved candidate bytes were published to the host workspace; it is not merge approval and does not imply a commit.
- For series, inspect both the parent and the stopped child. The parent tells where the series stopped; the child has the specific Gate report/logs.
- For completed series, inspect `.harness/series/<series-id>.json` and
  `autoCommit.enabled` before saying source changes were committed. With
  `autoCommit.enabled=false`, completed means the ledger reached completed
  state; it does not imply a git commit.

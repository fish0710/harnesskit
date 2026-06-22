# Claude Command Heartbeat Design

## Problem

Real Harness runs can spend several minutes inside the Daytona Agent sandbox
while Claude Code is executing. In the current implementation, the CLI may show
no visible activity during that phase. A supervising agent can then incorrectly
infer that the run or sandbox is stuck, even though Claude is still working.

The previous stream-tail experiment showed that relying on
`HARNESS_CLAUDE_STREAM_PATH` as the live signal is not stable enough: in a real
run, the stream file stayed at zero bytes until the Claude command finished and
was then archived successfully. That final archive is useful after completion,
but it is not a reliable liveness indicator during execution.

## Goal

Provide a simple, trustworthy liveness signal while `harness run --driver
claude` is inside the Claude command phase.

- Emit a periodic `agent.command.heartbeat` while the remote Claude command is
  still pending.
- Make the heartbeat independent from Claude stdout, stream-json output, and
  remote file polling.
- Stop the heartbeat immediately when the Claude command resolves, rejects, or
  times out.
- Record heartbeat events in RunStore so a supervising process can inspect the
  latest run and know that Harness is still waiting on the Agent command.
- Update the `harness-prep` skill/run-supervision guidance to say that no
  Claude command output is normal; heartbeat means the task is still running.
- Preserve existing final observability artifacts: raw stream-json stdout and
  copied `.claude` home snapshot after command completion.

## Non-goals

- Do not require real-time visibility into Claude Code text, tool calls, or
  token output.
- Do not parse `~/.claude/projects` as part of the automated liveness signal.
- Do not change Gate readiness preflight or publication behavior.
- Do not add a new driver.
- Do not expose prompt text, credentials, or model provider secrets in
  heartbeat payloads.

## Root Cause

The missing signal is not a Gate or sandbox readiness failure. The real run
proved:

1. Gate preflight completed with `readinessErrors: []`.
2. Agent sandbox creation, upload, agent preflight, and observability setup
   completed.
3. Claude command eventually exited `0`.
4. Candidate collection, Gate execution, and publication completed.

The problem is observability during the wait. A quiet Claude command is not the
same as a stuck Harness run. Harness needs to say, explicitly and repeatedly,
"the remote command is still pending."

## Design

Add a host-side heartbeat wrapper around the Claude command promise.

```text
agent.command.start
  -> start heartbeat timer
  -> run remote Claude command
  -> emit agent.command.heartbeat every interval while pending
  -> command settles
  -> stop timer
agent.command.end
```

The heartbeat payload should be intentionally small:

```json
{
  "id": "agent sandbox id",
  "attempt": 1,
  "kind": "claude",
  "elapsedMs": 90000,
  "claudeStreamPath": "/harness-observability/attempt-1/claude-stream.jsonl"
}
```

`claudeStreamPath` is optional and should only be present when observability is
enabled. The heartbeat should not claim Claude made progress; it only proves
Harness is still actively waiting on the remote Agent command.

Keep the existing `agent.command.no-output-warning` behavior only if useful for
stream/file diagnostics, but the primary liveness signal is heartbeat. A
supervising agent should not treat missing stdout or missing stream bytes as a
failure while heartbeats continue.

## Skill Guidance

Update the local `harness-prep` plugin guidance, especially run supervision and
blocker analysis references:

- During `agent.command.start` to `agent.command.end`, no Claude output can be
  normal.
- If `agent.command.heartbeat` continues, the run should be treated as active,
  not stuck.
- Only escalate as likely stuck when heartbeat stops unexpectedly, the CLI
  process exits, the command times out, or RunStore records an error.
- For long-running active commands, human/operator diagnostics may inspect the
  live Agent sandbox.

## Manual Claude Session Inspection

Claude Code commonly maintains session/project files under its home directory,
and Harness already records `claudeConfigDir` such as `/home/daytona/.claude`.
While the Agent sandbox is still alive, an operator can attach to that sandbox
and inspect the directory tree under the recorded Claude config dir, for
example by listing `projects/` and checking the newest session file.

This should remain a manual diagnostic path:

- The exact file layout is Claude Code internal behavior and may change.
- It should not become the automated liveness signal.
- It is only available while the Agent sandbox is still running; after normal
  cleanup, use the copied `.claude` snapshot recorded by Harness instead.

## Testing

Use TDD with fake sandbox handles:

- Unit test a heartbeat helper: it emits heartbeat while a promise remains
  pending and stops after the promise resolves.
- Environment test: during a held Claude command, `agent.command.heartbeat`
  appears before `agent.command.end`.
- RunStore test: heartbeat events are persisted and update the current attempt
  summary with last heartbeat metadata.
- Skill/documentation test or static assertion: `harness-prep` docs mention
  heartbeat semantics and that no Claude command output can be normal.

## Acceptance

- `npm run check` passes.
- Targeted heartbeat, environment, RunStore, and plugin-doc tests pass.
- A future real run gives observers a stable "still running" signal during
  quiet Claude command periods without needing live Claude stream parsing.

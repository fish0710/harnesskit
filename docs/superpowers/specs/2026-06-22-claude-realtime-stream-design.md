# Claude Realtime Stream Design

## Problem

The first Claude stream observability implementation tailed
`HARNESS_CLAUDE_STREAM_PATH` while Claude ran through Daytona
`executeCommand`. Real testing in
`/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab` showed the workflow passed,
but the stream file stayed at zero bytes for the whole Claude run and appeared
only after command completion. The CLI emitted no-output warnings and archived
the final stream, but it could not show real-time text/tool/progress events.

## Goal

Make Claude command execution produce live Harness observations while the Agent
sandbox is running:

- `agent.claude.text`, `agent.claude.tool`, `agent.claude.result`, and
  `agent.command.progress` must be emitted from live output chunks before the
  command resolves.
- `agent.command.no-output-warning` must still fire when Claude produces no
  observable output for the configured interval.
- The raw stream-json output must still be persisted for post-run diagnosis and
  session id parsing.
- Existing Gate preflight, publication, and run retry behavior must remain
  unchanged.

## Non-goals

- Do not add a new driver.
- Do not change the Gate readiness barrier.
- Do not stream secrets, prompt text, or model credentials into observations.
- Do not require live network calls in unit tests.

## Root Cause

The broken real-time path used a remote file as the live transport:

```sh
claude --output-format stream-json > "$HARNESS_CLAUDE_STREAM_PATH"
cat "$HARNESS_CLAUDE_STREAM_PATH"
```

This is reliable for final archival, but not reliable as a live signal in the
observed Daytona environment. Either the process writes only when stdout is a
regular file, or Daytona file download does not expose open-file writes
consistently. In both cases, polling the file cannot prove that Claude is
active.

The reliable live boundary already exists: Daytona PTY `onData` provides chunks
while a command is still running. Harness already uses PTY for command agents.

## Design

Run Claude through the sandbox PTY path when observability is enabled. The PTY
output callback becomes the real-time stream source:

```text
Claude Code stream-json stdout
  -> PTY onData chunk
  -> consumeClaudeStreamChunk
  -> Harness observations and RunStore progress
```

The shell command should also write the same stdout to
`HARNESS_CLAUDE_STREAM_PATH` with `tee` so the raw stream remains available
after completion:

```sh
claude --output-format stream-json | tee "$HARNESS_CLAUDE_STREAM_PATH"
```

The command must preserve Claude's exit status, not `tee`'s exit status.

When observability is disabled, keep the existing `executeCommand` path. This
limits behavioral change to the mode that needs live output.

## Interfaces

- Extend `SandboxHandle.runPty` with an optional output callback.
- Add a stream helper that:
  - creates a `ClaudeStreamState`,
  - parses PTY chunks with `consumeClaudeStreamChunk`,
  - emits no-output warnings on a timer while the command is pending,
  - returns the underlying command result unchanged.
- Keep `tailClaudeStreamDuring` as a fallback/file-tail helper for tests and
  future non-PTY providers.

## Testing

Use TDD with fake Daytona handles:

- Unit test the new live stream helper: a chunk emitted while `run` is pending
  must produce progress before the promise resolves.
- Integration-style environment test: fake `runPty` emits a Claude tool chunk,
  holds the command pending, and asserts `agent.command.progress` appears before
  `agent.command.end`.
- Command construction test: the observability command uses `tee` and preserves
  the Claude pipeline status.
- Regression test: no-output warning still fires for a pending PTY run with no
  chunks.

## Acceptance

- `npm run check` passes.
- Targeted stream/environment tests pass.
- A future real run should show live `agent.command.progress` or
  `agent.claude.*` events as soon as Claude emits stream-json on stdout.

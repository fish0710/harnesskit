# Claude Stream Observability V1 Design

## Goal

Make `harness run --driver claude` visibly alive while Claude Code is running
inside a Daytona Agent sandbox. The operator should see live progress in the
CLI and the RunStore should record enough progress metadata to distinguish a
slow model/tool call from a genuinely stalled run.

This design implements the first and third parts of the proposed observability
improvement together:

1. Tail the remote `claude-stream.jsonl` side channel while the Claude command is
   still running.
2. Persist and display progress events through the existing observation path.

PTY streaming is intentionally outside this v1. The current Claude Daytona path
uses `executeCommand`, and keeping it there avoids changing Claude Code's TTY
behavior while still exposing the stream-json transcript in near real time.

## Current Problem

The Daytona Claude command already writes full stream-json output to:

```text
/harness-observability/attempt-<n>/claude-stream.jsonl
```

However, current Harness code only observes that file after the remote command
returns. During long Claude runs the host receives `agent.command.start`, then
nothing until `agent.command.end`. This creates an operational blind spot:

- the model can be actively making API calls;
- the Agent can be running tools;
- the stream file can be growing;
- but the CLI and RunStore look idle.

That blind spot caused a real interruption after the Agent had already
completed and the flow had moved into Gate upload.

## Non-Goals

- Do not replace `executeCommand` with PTY for Claude Code in this feature.
- Do not stream raw prompts, raw command output, or full transcript content into
  the host run record.
- Do not expose model credentials, environment values, or arbitrary tool output
  in CLI summaries.
- Do not change Gate sandbox behavior.
- Do not change publication, retry, or gate readiness semantics.

## Architecture

Add a pure TypeScript stream parser/tailer module:

```text
src/harness/claude-stream.ts
```

The module has two responsibilities:

1. Parse complete new JSONL lines from Claude Code stream-json output.
2. Poll a readable stream file while an async command promise is pending.

The parser emits normalized observation events. It does not import Daytona SDK
types and does not write to disk. The Daytona run environment wires it to the
existing `SandboxHandle` and `onObservation` callback.

The high-level flow is:

```text
prepare observability dir
emit agent.command.start
start tailer around Claude command
  tailer polls HARNESS_CLAUDE_STREAM_PATH
  tailer emits progress/tool/text/result observations
Claude command exits
tailer final-drains stream file
snapshot .claude
emit agent.command.end
continue candidate collection and gate
```

## Event Contract

### `agent.command.progress`

Emitted when the stream file grows and at least one complete JSONL event was
parsed.

```json
{
  "id": "agent-sandbox-id",
  "attempt": 1,
  "path": "/harness-observability/attempt-1/claude-stream.jsonl",
  "bytes": 64149,
  "lastEventType": "assistant",
  "lastTool": "Bash",
  "lastActivityAt": "2026-06-22T08:00:00.000Z"
}
```

`bytes` is the parsed byte offset, not necessarily the total file size if the
last line is partial. `lastTool` is included only after a tool-use event.

### `agent.claude.tool`

Emitted when an assistant message contains a `tool_use` block.

```json
{
  "id": "agent-sandbox-id",
  "attempt": 1,
  "tool": "Bash",
  "command": "npm install --package-lock-only --legacy-peer-deps ..."
}
```

Only safe summaries are emitted. For Bash, keep a truncated command string. For
file tools, keep file path. Unknown input fields are ignored.

### `agent.claude.text`

Emitted for assistant text blocks with a short truncated summary.

```json
{
  "id": "agent-sandbox-id",
  "attempt": 1,
  "text": "Peer conflict on @dcloudio/types. I will use --legacy-peer-deps..."
}
```

### `agent.claude.result`

Emitted when the final stream-json result appears.

```json
{
  "id": "agent-sandbox-id",
  "attempt": 1,
  "sessionId": "39e23e8c-8cbd-4b6f-8011-4d62c3cf4276",
  "durationMs": 478635,
  "durationApiMs": 439449,
  "ttftMs": 57728,
  "turns": 16
}
```

### `agent.command.no-output-warning`

Emitted if the tailer can read the stream path but no new complete JSONL line
arrives for the configured warning window while the command is still running.

```json
{
  "id": "agent-sandbox-id",
  "attempt": 1,
  "path": "/harness-observability/attempt-1/claude-stream.jsonl",
  "bytes": 128,
  "idleMs": 60000
}
```

This is a warning, not a failure. It tells the operator that Harness is still
supervising the command.

## RunStore Persistence

RunStore should not persist the full transcript. It should persist compact
attempt metadata from `agent.command.progress`:

- `claudeStreamBytes`
- `claudeLastEventType`
- `claudeLastTool`
- `claudeLastActivityAt`

The existing raw `events[]` array continues to record observation events. The
attempt-level fields make status review fast without scanning the whole event
list.

## CLI Output

The CLI already prints redacted observation events from `onObservation`. This
feature can initially rely on that path. The important behavior is that new
events appear while the command is running, not only after it exits.

Future CLI formatting can compress these events into friendlier one-line status
messages, but v1 should keep the event names explicit to aid debugging.

## Error Handling

- If the stream file does not exist yet, polling continues silently.
- If a read fails transiently, the tailer emits no event and retries on the next
  interval.
- Invalid JSON lines are ignored after advancing past the complete line. Claude
  stream-json should be valid, but one malformed line should not kill the Agent
  run.
- Partial trailing lines are buffered until a later poll completes them.
- If the Claude command rejects or exits non-zero, the tailer still performs a
  final drain before rethrowing/returning the command result to existing code.
- If observability is disabled or no stream path exists, the Claude path keeps
  the current direct `handle.execute()` behavior.

## Security

The tailer emits summaries only. It must not mirror full tool results, full
assistant messages, prompt text, or environment values into CLI output or
attempt metadata.

Summary fields are bounded:

- assistant text: at most 300 characters;
- command/path/pattern summaries: at most 300 characters;
- no recursive object serialization of arbitrary tool input.

The durable volume remains the source of truth for full transcripts, with the
same sensitivity profile as the existing observability artifact design.

## Verification

Use TDD for each behavior:

1. Unit-test JSONL parsing and offset handling in `test/claude-stream.test.ts`.
2. Unit-test polling around a pending command in `test/claude-stream.test.ts`.
3. Integration-test Daytona environment observation ordering in
   `test/daytona-environment.test.ts`: progress must be observable before
   `agent.command.end`.
4. Unit-test RunStore attempt metadata in `test/observability.test.ts`.
5. Run targeted tests, then `npm run check`, then `git diff --check`.

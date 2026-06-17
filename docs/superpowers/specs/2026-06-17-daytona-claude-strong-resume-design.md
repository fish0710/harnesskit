# Daytona Claude Strong Resume Design

> Status: approved design draft
>
> Date: 2026-06-17
>
> Scope: `harness run --driver claude` in Daytona agent sandboxes

## Problem

Harness currently keeps one Daytona agent sandbox across retry attempts, and it
creates a fresh gate sandbox for every gate attempt. That satisfies the
filesystem/sandbox part of the retry model.

The missing behavior is Claude session continuity. A failed gate feeds
diagnostics into the next agent attempt, but the next attempt starts a new
Claude CLI process without a required resume session id. The result is "same
agent sandbox, new Claude conversation" rather than "same agent sandbox, same
Claude conversation resumed."

Current observability also points `CLAUDE_CONFIG_DIR` at an attempt-scoped
directory. That makes each attempt write and read a different local Claude
state tree, which can break explicit resume even if Harness captures the
session id.

## Goals

- A failed gate must return diagnostics to the original Daytona agent sandbox.
- Claude retry attempts must strongly resume the original Claude session.
- Harness must fail closed if it cannot prove the next attempt can resume the
  original Claude session.
- Gate sandbox isolation must remain unchanged: every remote gate attempt gets a
  fresh agent-free sandbox and is deleted after evidence collection.
- Different harness tasks must keep their persisted `.claude` state isolated
  from each other.
- Host-side run records must make the session/resume behavior inspectable.

## Non-goals

- Do not add Langfuse keys or OpenTelemetry instrumentation to the agent
  sandbox.
- Do not change command-agent behavior.
- Do not reuse gate sandboxes.
- Do not merge, push, approve, or bypass CI.
- Do not introduce cross-run Claude memory sharing.

## Chosen Approach: Strong Resume With Per-run Claude State

Harness will use a strong resume contract:

1. The first Claude attempt runs normally.
2. Harness parses the Claude stream-json output and captures the session id.
3. Every later Claude attempt must run with `claude --resume <sessionId>`.
4. If the first attempt completes without a session id, Harness throws and stops
   the automatic loop.
5. If a later attempt is about to run without a captured session id, Harness
   throws before starting Claude.

This deliberately rejects soft fallback behavior. A fallback to a fresh Claude
conversation would hide the exact failure this design is meant to prevent.

## Rejected Alternatives

### Soft resume

Harness could resume when a session id is available and otherwise fall back to a
new `claude -p` run in the same sandbox.

This is rejected because it does not guarantee conversation continuity. It would
preserve files but not the agent reasoning context.

### Stable config only

Harness could set a stable `CLAUDE_CONFIG_DIR` and rely on Claude CLI behavior
without passing `--resume`.

This is rejected because it does not make resume explicit or testable. Stable
config is necessary, but not sufficient.

## Directory Model

The Daytona volume remains shared at the volume level, but every harness run
uses a distinct subpath:

```text
harness-claude-observability/
  runs/
    <runId-A>/
      .claude/
    <runId-B>/
      .claude/
```

Each agent sandbox mounts only its own run subpath:

```text
volumeName: harness-claude-observability
mountPath: /harness-observability
subpath: runs/<runId>
```

Inside the sandbox, every run sees the same stable path:

```text
CLAUDE_CONFIG_DIR=/harness-observability/.claude
HARNESS_OBSERVABILITY_RUN_ROOT=/harness-observability
```

That path is stable across attempts in the same harness run, but it is isolated
between different harness runs because the Daytona volume mount subpath differs
by `runId`.

Attempt numbers remain logical metadata:

```text
HARNESS_ATTEMPT=1
HARNESS_ATTEMPT=2
```

They are recorded in the host manifest and observation events. They must not
select a different `CLAUDE_CONFIG_DIR`.

## Why Attempt-scoped CLAUDE_CONFIG_DIR Is Wrong For Resume

Claude CLI resume depends on local Claude state. If attempt 1 writes the session
state under one config directory and attempt 2 reads from another, the second
process may not find the session it is told to resume.

Broken model:

```text
attempt 1:
CLAUDE_CONFIG_DIR=/harness-observability/attempt-1/.claude
session abc is written there

attempt 2:
CLAUDE_CONFIG_DIR=/harness-observability/attempt-2/.claude
claude --resume abc cannot rely on finding attempt-1 state
```

Target model:

```text
attempt 1:
CLAUDE_CONFIG_DIR=/harness-observability/.claude
session abc is written there

attempt 2:
CLAUDE_CONFIG_DIR=/harness-observability/.claude
claude --resume abc reads the same local state tree
```

## Command Model

The fixed command string should be replaced with command construction.

Initial attempt:

```text
exec "/usr/local/bin/claude" --dangerously-skip-permissions \
  -p "$HARNESS_PROMPT" --output-format stream-json --verbose
```

Resume attempt:

```text
exec "/usr/local/bin/claude" --dangerously-skip-permissions \
  --resume "$HARNESS_CLAUDE_SESSION_ID" \
  -p "$HARNESS_PROMPT" --output-format stream-json --verbose
```

The exact resume flag must be verified against the pinned Claude Code runtime
before final implementation. The production API should still encode the strong
resume intent so tests can assert the selected command and env.

## Session Id Capture

Harness will parse Claude stream-json stdout after each Claude command.

Accepted session id sources should be narrow and explicit. The expected primary
source is a top-level JSON object field named `session_id` or `sessionId`.
Harness should scan line-delimited JSON and capture the first non-empty safe
string.

Session id validation:

- must be a non-empty string;
- must not contain NUL;
- must not contain shell control characters;
- should be passed through env, not interpolated into shell text.

If a later attempt emits the same session id, Harness keeps it. If it emits a
different session id during a resume attempt, Harness records the new value only
if Claude CLI documents that session ids may rotate during resume. Otherwise it
should treat a changed id as an error. The safer first implementation is to
require stability.

## Observation And Run Record

Observation events should include non-secret resume metadata:

- `agent.command.start`: attempt, sandbox id, `claudeConfigDir`, resume boolean,
  and session id presence;
- `agent.command.end`: attempt, exit code, captured session id if present, and
  resume boolean;
- `agent.observability.start`: attempt and stable `claudeConfigDir`.

The host run manifest should record per-attempt session metadata:

- `claudeConfigDir`;
- `claudeSessionId`;
- `resumedFromSessionId`;
- `exitCode`;
- gate sandbox ids and gate outcome.

The manifest remains a sensitive operational artifact. It is not a public log.

## Failure Semantics

### First attempt has no session id

If Claude exits but Harness cannot capture a session id, `runTask()` throws. The
automatic loop stops because strong resume cannot be guaranteed.

### Later attempt has no saved session id before command start

Harness throws before starting Claude. This prevents accidental fresh
conversation fallback.

### Resume command exits non-zero or throws

Harness records `agent.command.end` with error outcome and propagates the
failure, preserving current fail-closed behavior.

### Gate fails or errors

Harness keeps the same agent sandbox alive and sends diagnostics to the next
Claude resume attempt.

### Gate passes

Harness publishes the exact gate-approved candidate snapshot and then cleans up
the agent sandbox according to current policy.

## Security And Isolation

- Agent sandbox still receives model credentials only as command environment.
- Gate sandbox still receives no model credentials, no Claude config volume, and
  no agent runtime.
- Stable `CLAUDE_CONFIG_DIR` does not create cross-task memory because the
  Daytona volume mount is scoped to `runs/<runId>`.
- Session id is operational metadata. Treat it as sensitive enough for
  manifests, but it is not a gate credential and must never influence gate
  verdicts.

## Test Plan

Unit coverage should be added before implementation.

Required tests:

- two failed-then-passing Claude attempts create one agent sandbox and two fresh
  gate sandboxes;
- first Claude command uses initial command form;
- second Claude command uses resume command form;
- second command receives `HARNESS_CLAUDE_SESSION_ID`;
- both attempts use the same `CLAUDE_CONFIG_DIR`;
- first attempt stdout without a session id causes `runTask()` to reject;
- later attempt cannot start if no session id is saved;
- gate sandbox requests still have no model credentials, no observability
  volume, and no Claude resume env.

Existing command-agent retry tests should remain unchanged.

## Implementation Boundaries

Expected write set:

- `src/harness/sandbox/daytona.ts`: command builder and session id parser;
- `src/harness/sandbox/environment.ts`: strong resume state machine and stable
  Claude config dir injection;
- `src/harness/observability.ts`: path model update if needed;
- `src/harness/record.ts`: optional run record session metadata;
- `test/daytona-environment.test.ts`: focused red/green tests;
- docs that currently describe attempt-scoped `CLAUDE_CONFIG_DIR`.

Do not change gate sandbox lifecycle, candidate collection, publisher, or
command-agent behavior unless a test exposes a direct integration need.

## Self-review

- No placeholders remain.
- The design explicitly separates same-run resume state from cross-run volume
  isolation.
- The design rejects fallback behavior so the implementation cannot silently
  start a fresh Claude conversation after gate failure.
- The scope is small enough for one implementation plan and does not require
  unrelated refactoring.

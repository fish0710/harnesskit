# Daytona Claude Observability Persistence Design

## Goal

Persist full observability artifacts for every `harness run --driver claude`
Daytona execution so an operator can inspect what Claude Code did even after
the Agent sandbox is deleted.

The key product requirement is explicit: Daytona Claude runs persist `.claude`
by default. The persisted artifacts may contain prompts, source code, command
output, tool results, and secrets printed by tools. Harness does not redact or
minimize the `.claude` artifacts in this feature.

## Context

Current Daytona execution already has the right trust boundary:

- one persistent Agent sandbox runs Claude Code and mutates candidate files;
- every gate attempt runs in a fresh Agent-free Gate sandbox;
- host code owns contract loading, evidence classification, retry,
  escalation, candidate collection, and publication;
- Gate sandboxes do not receive model credentials or Langfuse credentials.

The current observability gap is that host-side Langfuse instrumentation wraps
the local Claude Agent SDK driver, but the Daytona path launches the Claude Code
CLI inside the remote sandbox. As a result, host Langfuse cannot see Claude
tool calls. The Daytona path also deletes the sandbox on normal completion, so
the default `~/.claude` transcript may disappear with it.

The research report confirms the robust persistence shape: point
`CLAUDE_CONFIG_DIR` at a Daytona persistent volume from the start, and record a
host-side manifest before the Agent command runs.

## Confirmed Approach

Use Daytona volumes as the durable artifact store and host `.harness/runs` as
the durable index.

On each Daytona Claude run, Harness will:

1. generate a stable `runId` before creating any sandbox;
2. write an initial host run manifest before running the Agent;
3. create or resolve a Daytona volume for observability;
4. mount that volume only into the Agent sandbox;
5. set `CLAUDE_CONFIG_DIR` to a run/attempt-specific path in the mounted volume;
6. append host lifecycle events to the run manifest as the run progresses;
7. keep Gate sandboxes free of the observability volume and all model or
   observability credentials.

The default volume name is:

```text
harness-claude-observability
```

The default mount path inside the Agent sandbox is:

```text
/harness-observability
```

The default Claude config directory for attempt `n` is:

```text
/harness-observability/runs/<runId>/attempt-<n>/.claude
```

This preserves Claude Code's native layout under that directory, including:

- `projects/<encoded-cwd>/<session-id>.jsonl`;
- session sidecar directories such as `tool-results/` and `subagents/`;
- supporting `.claude` application data such as `tasks/`, `session-env/`, and
  `debug/` when Claude Code writes them.

## Configuration

The feature is default-on for Daytona Claude runs.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_DAYTONA_OBSERVABILITY_VOLUME` | `harness-claude-observability` | Daytona volume name or id to mount into Agent sandboxes. |
| `HARNESS_DAYTONA_OBSERVABILITY_MOUNT` | `/harness-observability` | Absolute mount path in the Agent sandbox. |
| `HARNESS_DAYTONA_OBSERVABILITY` | `1` | Set to `0`, `false`, or `off` only for operational recovery if volume creation is unavailable. |

Disabling persistence is not the normal path. It exists so a broken Daytona
volume service does not make all non-production experimentation impossible.
When disabled, the run manifest still records that `.claude` persistence was
disabled.

## Host Manifest

The host manifest is the lookup index for users and tools. It is created before
the Agent sandbox runs.

Path:

```text
.harness/runs/<runId>.json
```

Minimum shape:

```json
{
  "schemaVersion": 2,
  "runId": "2026-06-16T12-00-00-000Z-7f3a2c1b",
  "createdAt": "2026-06-16T12:00:00.000Z",
  "updatedAt": "2026-06-16T12:00:10.000Z",
  "task": "implement the task",
  "driver": "daytona(claude)",
  "status": "running",
  "observability": {
    "enabled": true,
    "backend": "daytona-volume",
    "volumeName": "harness-claude-observability",
    "mountPath": "/harness-observability",
    "runRoot": "/harness-observability/runs/2026-06-16T12-00-00-000Z-7f3a2c1b"
  },
  "attempts": [
    {
      "attempt": 1,
      "claudeConfigDir": "/harness-observability/runs/2026-06-16T12-00-00-000Z-7f3a2c1b/attempt-1/.claude",
      "agentSandboxId": "sandbox-id",
      "startedAt": "2026-06-16T12:00:01.000Z",
      "endedAt": "2026-06-16T12:00:08.000Z",
      "exitCode": 0,
      "gateSandboxIds": ["gate-sandbox-id"],
      "gateOutcome": "pass"
    }
  ],
  "events": [
    {
      "at": "2026-06-16T12:00:00.100Z",
      "event": "run.record.created",
      "data": { "runId": "2026-06-16T12-00-00-000Z-7f3a2c1b" }
    }
  ],
  "outcome": "ready_for_mr",
  "summary": { "total": 6, "pass": 6, "fail": 0, "error": 0, "needsReview": 0 }
}
```

Existing consumers of run records should keep working with v1 records. New code
will read both shapes and write v2 for new runs.

The manifest records task text and lifecycle metadata without redaction. It
does not try to duplicate the full `.claude` transcript; the volume is the
source of truth for Claude internals.

## Data Flow

### Run start

`src/cli.ts` creates a `RunRecorder` before constructing the Daytona run
environment. If the recorder cannot create the initial manifest, the run fails
before creating an Agent sandbox.

The recorder receives `onObservation` events from the Daytona environment and
persists them incrementally. Console output can continue to use the existing
redaction helper; the file manifest is allowed to be complete.

### Agent sandbox creation

For `agent.kind === "claude"`, `createDaytonaRunEnvironment()` requests an
Agent sandbox with:

```ts
volumes: [{
  volumeId: "<resolved volume name or id>",
  mountPath: "/harness-observability"
}]
```

Gate sandbox create requests never include this volume.

The Daytona SDK provider is responsible for resolving or creating the volume
when persistence is enabled. If volume resolution fails, Harness fails before
the Agent command runs. This preserves the requirement that task metadata and
artifact location are known before execution.

### Agent attempt

For each Agent attempt, the environment computes:

```text
runRoot=/harness-observability/runs/<runId>
attemptRoot=/harness-observability/runs/<runId>/attempt-<n>
claudeConfigDir=/harness-observability/runs/<runId>/attempt-<n>/.claude
```

The Claude command receives:

```text
CLAUDE_CONFIG_DIR=<claudeConfigDir>
HARNESS_RUN_ID=<runId>
HARNESS_ATTEMPT=<n>
HARNESS_OBSERVABILITY_RUN_ROOT=<runRoot>
HARNESS_OBSERVABILITY_ATTEMPT_ROOT=<attemptRoot>
```

Before launching Claude, Harness creates the attempt directory in the Agent
sandbox. Claude Code then writes its native transcript and sidecars directly to
the volume.

### Gate attempt

Gate sandboxes remain unchanged:

- no Claude Code process and no Agent runtime Snapshot;
- no Anthropic variables;
- no Langfuse variables;
- no observability volume;
- fresh sandbox per gate attempt;
- deleted after the gate run.

The host manifest records Gate sandbox ids, outcomes, and cleanup status so an
operator can correlate host decisions with Agent-side `.claude` artifacts.

### Cleanup

Deleting the Agent sandbox must not delete the observability volume. If sandbox
cleanup fails, the manifest records that failure. If cleanup succeeds, the
manifest still points to the volume path for later inspection.

## Error Handling

- Missing Daytona API key still fails before provider creation.
- Invalid or blank observability volume name fails before Agent creation.
- Invalid observability mount path fails before Agent creation.
- Volume resolution or creation failure fails the run before Agent execution,
  unless `HARNESS_DAYTONA_OBSERVABILITY=0` is explicitly set.
- Initial manifest write failure fails before Agent creation.
- Incremental manifest update failure fails closed after the current host-side
  step and prevents silently losing the audit trail.
- Claude command failure still produces a run manifest and leaves `.claude`
  artifacts in the volume.
- Gate failures are recorded in the manifest but do not grant the Agent any new
  authority.

## Security And Privacy

This feature intentionally persists raw Claude Code artifacts. Operators must
treat the Daytona volume and `.harness/runs` directory as sensitive engineering
logs.

The design does not introduce Langfuse credentials into the Agent sandbox. It
also does not introduce any credentials into Gate sandboxes. The new volume
mount increases retained data, not execution authority.

## Testing Strategy

Unit tests should cover:

- run manifest creation before Agent execution;
- v1 run record compatibility;
- observability config defaults and validation;
- Daytona provider passes `volumes` only to Agent create requests;
- Gate create requests do not receive the observability volume;
- Claude command env includes `CLAUDE_CONFIG_DIR` and run/attempt metadata;
- manifest attempts capture Agent sandbox id, Claude config path, Gate sandbox
  id, command exit code, and final outcome;
- disabled mode records `observability.enabled=false`;
- CLI console observations remain redacted while the manifest can retain full
  event data.

Integration tests remain opt-in. A Daytona integration check should verify that
a real Claude run creates a volume-backed `.claude` directory and that the
final host record points to it. This should not run during `npm run check`.

## Documentation Updates

Update:

- `README.md` with the default persistence behavior and volume name;
- `docs/daytona-local-claude-code-runbook.md` with inspection commands;
- `docs/architecture/daytona-sandbox-gate.md` with the new Agent-only volume;
- `docs/architecture/daytona-langfuse-observability.md` to clarify that this is
  artifact persistence, not Langfuse SDK tracing.

## Non-Goals

- Building a web viewer for `.claude` transcripts.
- Parsing Claude JSONL into a normalized event graph.
- Shipping `.claude` artifacts to Langfuse.
- Persisting Gate sandbox files beyond host manifest metadata.
- Redacting, encrypting, or minimizing raw Claude Code artifacts.

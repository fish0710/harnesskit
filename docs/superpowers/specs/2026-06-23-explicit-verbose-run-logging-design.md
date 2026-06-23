# Explicit Verbose Run Logging Design

## Problem

Harness runs currently expose only a small set of human-oriented status lines
while the real work is happening. The run record stores some loop logs and many
Daytona observation events, but the information is split across terminal output
and JSON run records. When a run fails or appears stuck, the operator cannot
quickly see which step is active, which setup step just failed, or which
observation event explains the current state.

## Goal

Add an explicit detailed logging mode for `harness run` and `harness fix`.

- Enable it with `--verbose`; also support `HARNESS_VERBOSE=1` for scripts.
- Keep normal output unchanged when verbose mode is off.
- Print detailed events to the terminal in real time when verbose mode is on.
- Persist the same detailed events to a per-run JSONL file under `.harness/runs`.
- Link the JSONL file from the run record and final CLI output.
- Reuse the existing redaction logic so secrets do not appear in verbose output
  or log files.

## Non-goals

- Do not make verbose logging the default.
- Do not change gate pass/fail semantics, retry behavior, or publication
  behavior.
- Do not replace the existing structured `events` array in run records.
- Do not add a remote log transport or cloud backend.
- Do not expose raw prompt text, credentials, tokens, cookies, or API keys.

## Design

Introduce a small host-side diagnostic logger used by the CLI and run loop.
The logger is created after the run id is known, before setup work starts.

When disabled, it should be cheap and silent. When enabled, each log call:

1. Creates a structured entry with `at`, `level`, `phase`, `message`, and
   optional redacted `data`.
2. Prints a compact human-readable line to stdout.
3. Appends the full entry as one JSON object per line to
   `.harness/runs/<runId>.log.jsonl`.

The run record gains an optional `diagnosticLogPath` field. `RunStore` validation
accepts the field, and `harness runs show --json` includes it automatically.
The normal final CLI output adds a diagnostic log path line only when verbose
logging is enabled.

## Coverage

Verbose logs should cover these phases:

- `run.setup`: run record creation, agent selection, config loading, policy
  loading, contract loading, contract selection, gate construction, context
  setup, and budget setup.
- `preflight`: preflight start, static readiness summary, runtime preflight end,
  and any blocker before the agent loop starts.
- `sandbox`: Daytona observation events from sandbox creation, upload, setup,
  command execution, gate execution, cleanup, and publication.
- `loop`: attempt start, agent command start/end, gate start/end, diagnostics
  feedback generation, escalation decisions, retry decisions, publish start/end,
  and environment close.
- `series`: parent series start/stop, skipped tasks, child task start/end, and
  setup errors for child tasks.

Existing high-level `console.log` output remains the default user interface.
Verbose mode adds diagnostic detail around it; it does not remove or rewrite the
current summary lines.

## Data Flow

```text
CLI parse args/env
  -> create run id and run recorder
  -> create diagnostic logger
  -> setup steps call logger.debug/info
  -> Daytona onObservation records event and logs redacted event
  -> runLoop emits structured loop diagnostics
  -> completion/failure writes run record with diagnosticLogPath
```

For Daytona observations, continue writing the existing run record events. The
diagnostic logger should receive the already-redacted data for terminal and
JSONL output.

## Error Handling

- If opening or appending the diagnostic log file fails while verbose mode is
  enabled, fail fast before the agent work starts. A broken debug log should not
  produce a run that claims detailed logging was enabled but lost data.
- If a setup error occurs after the logger is created, record a final `error`
  level verbose entry before failing the run record.
- On normal or error exits, close the logger if it owns a file handle.
- Redaction applies recursively and preserves the current behavior for circular,
  unserializable, and secret-looking fields.

## CLI Surface

```text
harness run "<task>" --verbose ...
harness fix --verbose ...
HARNESS_VERBOSE=1 harness run "<task>" ...
```

Help text documents `--verbose` as "print and persist detailed run diagnostics".
The flag is intentionally scoped to run/fix/series execution. Other subcommands
may ignore it until they have a clear diagnostic-log use case.

## Testing

Use TDD before production code changes.

- Logger unit test: disabled logger is silent; enabled logger writes JSONL and
  prints compact redacted output.
- CLI run test: `harness run --driver scaffold --verbose` creates a run record
  with `diagnosticLogPath`, writes a JSONL file, and includes setup plus loop
  phases.
- CLI compatibility test: the same scaffold run without `--verbose` keeps the
  existing output and does not add a diagnostic log path.
- Error test: a setup failure after run creation writes an error verbose entry
  when verbose mode is enabled.
- Record validation test: RunStore can read records containing
  `diagnosticLogPath`.

## Acceptance

- `npm run check` passes.
- Targeted logger, run record, and CLI run tests pass.
- A verbose run gives enough real-time and persisted information to identify the
  active Harness phase and the last failed setup/agent/gate step.
- A non-verbose run behaves like it does today.

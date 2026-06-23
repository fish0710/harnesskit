# Commit Ledger

Base branch: `main`

Working branch: `feat/explicit-verbose-run-logging`

Merge base before archive:

```text
bca2127e5bb94eeb5694ad24045b36b9063003e4
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers explicit verbose Harness run diagnostics:

- create a reusable diagnostic logger;
- move observation redaction into a shared module;
- persist per-run diagnostic JSONL files;
- link JSONL paths from RunStore via `diagnosticLogPath`;
- emit run loop diagnostics for attempts, agent, gate, publish, retry/escalation,
  and environment close;
- wire `--verbose` and `HARNESS_VERBOSE=1` through run/fix/series execution;
- document verbose diagnostics usage;
- make built CLI package binaries executable after `npm run build`.

## Commits

```text
5d3be64 feat: add diagnostic run logger
c8db95f feat: link diagnostic logs from run records
3bf142d feat: emit run loop diagnostics
ab65e9f feat: wire verbose run diagnostics
09a7426 fix: make built CLI binaries executable
```

## Key Files

```text
package.json
src/cli.ts
src/harness/diagnostic-log.ts
src/harness/redaction.ts
src/harness/record.ts
src/harness/run.ts
test/diagnostic-log.test.ts
test/cli-run-record.test.ts
test/harness-run.test.ts
test/run-store.test.ts
docs/usage.md
docs/archive/2026-06-23-explicit-verbose-run-logging/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/diagnostic-log.test.js dist/test/cli-redaction.test.js dist/test/run-store.test.js dist/test/harness-run.test.js dist/test/cli-run-record.test.js
npm run build && node --test dist/test/cli-entrypoint.test.js
npm run check
```

Observed result:

```text
targeted tests 25 pass, 0 fail
cli-entrypoint test 1 pass, 0 fail
full check tests 575 pass, 0 fail
```

## Residual Risk

The JSONL logger writes synchronously from the host process. This is intentional
for reliable diagnostics, but extremely chatty future event streams may need
rate limiting. Current verbose output is explicit opt-in and scoped to run/fix
diagnostics, so this is acceptable for this change.

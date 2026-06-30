# Commit Ledger

Base branch: `main`

Working branch: `feat/claude-live-summary`

Merge base before archive:

```text
fb45dba841367417bf9f86f5538b9248748c2566
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers Claude live summary rendering for default Harness run output:

- add a CLI renderer for sandbox observation events;
- render Claude text, tool, result, and progress events as readable terminal
  summaries;
- keep fallback JSON rendering for non-Claude observations;
- keep verbose diagnostic logging behavior unchanged;
- add regression coverage for the renderer;
- verify through build, targeted tests, full tests, and a real Daytona Claude run.

## Key Files

```text
src/cli.ts
test/cli-redaction.test.ts
docs/archive/2026-06-30-claude-live-summary/
```

## Verification Before Archive

```text
npm run build
node --test dist/test/cli-redaction.test.js
node --test dist/test/cli-redaction.test.js dist/test/cli-run-record.test.js dist/test/frozen-contract-callers.test.js dist/test/daytona-environment.test.js
npm test
real harness run in /private/tmp/harness-live-summary.U1s45A
```

Observed result:

```text
build exit 0
cli-redaction tests 2 pass, 0 fail
targeted tests 50 pass, 0 fail
full tests 602 pass, 0 fail
real run printed Claude progress/tool/text/result summaries before agent.command.end
```

## Residual Risk

The renderer intentionally uses safe summaries already emitted by the existing
Claude stream tailer. It does not expose raw stream-json. Future event types may
need additional formatting, but the fallback preserves existing JSON-style
observation output.

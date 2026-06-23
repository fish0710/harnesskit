# Commit Ledger

Base branch: `main`

Working branch: `main`

Pre-archive base:

```text
4568c65 fix: verify miniprogram automation protocol readiness
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers removal of the fixed 20 minute Daytona Claude command
timeout:

- delete the `AGENT_COMMAND_TIMEOUT_MS` constant from Daytona run environment;
- stop passing timeoutMs to the Claude main `handle.execute(...)` call;
- update the Daytona environment regression test to require `undefined`
  timeout for the Claude main command;
- preserve bounded timeouts for setup and preflight;
- record verification evidence for red/green targeted tests and full suite.

## Key Files

```text
src/harness/sandbox/environment.ts
test/daytona-environment.test.ts
docs/archive/2026-06-23-claude-command-timeout-removal/
```

## Verification Before Archive

```text
npm run build && node --test dist/test/daytona-environment.test.js
npm run check
git diff --check
```

Observed result:

```text
targeted Daytona environment tests 32 pass, 0 fail
full check tests 577 pass, 0 fail
git diff --check exit 0
```

## Residual Risk

Removing the fixed timeout means a genuinely stuck Daytona Claude command will
not be terminated by Harness at 20 minutes. Operators should use
`agent.command.heartbeat`, run records, and external process/sandbox controls to
distinguish active long-running work from infrastructure stalls. This matches
the requirement for multi-hour Claude tasks and keeps shorter infrastructure
steps bounded.

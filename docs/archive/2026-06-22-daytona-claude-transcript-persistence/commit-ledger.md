# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
b12676b Add configurable run loop budget
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers the Daytona Claude transcript persistence correction:

- remove `CLAUDE_CONFIG_DIR` usage for Daytona Claude runs;
- keep Claude Code native state in sandbox-local `/home/daytona/.claude`;
- copy sandbox-local `.claude` into the run-scoped Daytona observability volume
  before Agent cleanup;
- persist raw Claude CLI `stream-json` stdout to
  `/harness-observability/attempt-<n>/claude-stream.jsonl`;
- record `attempts[].claudeStreamPath` in RunStore;
- update README, architecture docs, runbook, usage docs, and harness-prep skill
  references to the corrected inspection flow.

## Key Files

```text
src/harness/observability.ts
src/harness/record.ts
src/harness/sandbox/daytona.ts
src/harness/sandbox/environment.ts
src/index.ts
test/daytona-claude-resume.test.ts
test/daytona-environment.test.ts
test/observability.test.ts
plugins/harness-prep/skills/harness-prep/references/observability-and-review.md
plugins/harness-prep/skills/harness-prep/references/runstore-observability.md
```

## Review Before Archive

Manual diff review before archive checked:

- Agent volume mount remains run-root only.
- Claude command wrapper still emits stdout back to Harness after writing
  `claude-stream.jsonl`.
- RunStore records stream path at command start and again from the stream event.
- Snapshot copy runs after the Claude command and also attempts best-effort copy
  on command error.
- Gate sandboxes do not receive observability volume or model credentials.
- Plugin skill wording no longer says `.claude` is copied to the Harness host.

No blocking review findings were found.

## Verification Before Commit

```text
npm run check
git diff --check
```

Expected result:

```text
tests 442
pass 442
fail 0
```

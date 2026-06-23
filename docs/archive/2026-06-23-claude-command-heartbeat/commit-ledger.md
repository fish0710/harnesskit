# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
c5ab2fe docs: design realtime Claude stream
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers the Claude command heartbeat and harness-prep plugin refresh:

- add a reusable command heartbeat helper;
- emit `agent.command.heartbeat` during Daytona Claude command execution;
- validate heartbeat interval override values;
- persist latest heartbeat metadata in RunStore attempts;
- ignore invalid heartbeat elapsed metadata;
- document heartbeat supervision in harness-prep skill references;
- clarify heartbeat is only a liveness signal;
- bind heartbeat lifecycle to raw Claude command promise, not slow stream tailing;
- add local harnesskit plugin marketplace;
- refresh harness-prep plugin cachebuster for local reinstall.

## Key Commits

```text
fbcd10f docs: revise design for Claude command heartbeat
ff0813e docs: plan Claude command heartbeat
af7889f feat: add Claude command heartbeat helper
d13259f feat: emit heartbeat during Daytona Claude command
2a6e29c fix: validate Claude heartbeat interval override
919d79c feat: persist Claude command heartbeat metadata
82cb723 fix: ignore invalid heartbeat elapsed metadata
fb9a268 docs: document Claude command heartbeat supervision
4c8ab48 test: strengthen heartbeat guidance assertions
cb37dbe test: guard heartbeat liveness-only guidance
7e485db fix: bind Claude heartbeat to raw command lifetime
8711120 Merge branch 'claude-realtime-stream'
5b63e3d chore: refresh harness-prep plugin cachebuster
67972b9 chore: add harnesskit plugin marketplace
```

## Key Files

```text
src/harness/command-heartbeat.ts
src/harness/claude-stream.ts
src/harness/record.ts
src/harness/sandbox/environment.ts
test/command-heartbeat.test.ts
test/daytona-environment.test.ts
test/observability.test.ts
test/daytona-gate-snapshot.test.ts
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/references/run-supervision.md
plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md
plugins/harness-prep/skills/harness-prep/references/runstore-observability.md
.agents/plugins/marketplace.json
```

## Review Before Archive

Subagent and local review checked:

- timer lifecycle has no post-settlement heartbeat;
- raw command failure still propagates;
- heartbeat emitter failures do not mask command success/failure;
- RunStore folds only valid heartbeat metadata;
- skill wording does not tell supervisors to infer semantic progress from heartbeat;
- no remote Claude command output is required for liveness while heartbeat continues;
- plugin reinstall path points at the local harness-prep plugin.

Blocking finding fixed before archive:

- heartbeat must not wrap final stream tailing; otherwise a slow stream read after raw
  command completion can look like active Claude command work.

## Verification Before Commit

```text
npm run check
codex plugin list | rg -n "harnesskit|harness-prep"
real target run: /Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab
```

Expected result:

```text
tests 550
pass 550
fail 0
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260622101654
heartbeat observed while Claude command was running
```

# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
0211aec51e6a5aab163c8c673b9184a7c8ef0ef6
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers harness-prep skill updates for serial task recovery and
Agent/Gate dependency manifest boundaries:

- document that stopped serial task recovery must reuse the original
  `.harness/series/<series-id>.json` ledger;
- forbid changing `series.id` to bypass a failed task unless the user explicitly
  requests a full rerun;
- document preserving completed task `taskHash` records and confirming
  `skipped completed (taskHash unchanged)` before entering the failed task;
- move root dependency manifests and build setup files out of the sample
  `candidateRoots` and into `protectedPaths`;
- document when dependency manifests may intentionally be mutable;
- document scoped setup for isolated apps/subprojects;
- refresh and reinstall the local harness-prep plugin cache.

## Key Files

```text
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/references/run-supervision.md
plugins/harness-prep/skills/harness-prep/references/agent-environment.md
plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md
docs/archive/2026-06-23-harness-prep-serial-resume/
```

## Verification Before Commit

```text
git diff --check
python3 .../validate_plugin.py plugins/harness-prep
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
npm run build
node --test dist/test/harness-series.test.js dist/test/cli-series.test.js
npm run check
codex plugin add harness-prep@harnesskit
codex plugin list
cache rg check under /Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623034310
```

Observed result:

```text
diff check exit 0
Plugin validation passed
Skill is valid!
build exit 0
tests 57
pass 57
fail 0
full check tests 553 pass 553 fail 0
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623034310
cache contains the new serial resume and dependency boundary guidance
```

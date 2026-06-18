# Commit Ledger

Base branch: `main`

Feature branch: `codex/harness-prep-plugin`

Base commit:

```text
b4a9049 Merge branch 'codex/unified-runstore'
```

Archive commit: the commit containing this ledger.

## Scope

This branch contains the Harness Prep Codex plugin:

- plugin manifest under `plugins/harness-prep/.codex-plugin/plugin.json`;
- `harness-prep` skill entrypoint and OpenAI agent metadata;
- preparation workflow references for requirements, design, contracts, config, sandbox policy, run supervision, review, observability, RunStore, and blocker analysis;
- source evidence and reliability checklist references;
- archive documentation for this plugin.

## Verification Before Merge

```text
plugin validator
skill validator
reference/fence checks
git diff --check
npm run check
```

Expected result:

```text
plugin valid
skill valid
references ok 10
fences ok 11
tests 435
pass 435
fail 0
```

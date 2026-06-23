# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
bb4764044e912f8aa60473792dfdb253d04ced48
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers Harness read-only Agent context support:

- add `sandbox.readOnlyPaths` to sandbox policy;
- keep protected paths hidden and host-owned;
- upload read-only context files to Agent sandboxes;
- reject read-only add/modify/delete during candidate collection;
- keep candidate diff/publication scoped to mutable candidate files;
- preserve and verify read-only baseline files in Gate sandboxes and host-local gates;
- add scaffold/example defaults for `AGENTS.md`, `docs/specs`, and `docs/plans`;
- update Harness docs and harness-prep plugin/skill guidance;
- refresh and reinstall the local Codex `harness-prep` plugin cache.

## Key Files

```text
src/harness/sandbox/types.ts
src/harness/sandbox/policy.ts
src/harness/sandbox/workspace.ts
src/harness/sandbox/environment.ts
src/harness/host-gate.ts
src/harness/preflight.ts
src/harness/scaffold.ts
src/cli.ts
test/sandbox-policy.test.ts
test/sandbox-workspace.test.ts
test/daytona-environment.test.ts
test/host-gate.test.ts
test/preflight-runtime.test.ts
test/scaffold.test.ts
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/
docs/archive/2026-06-23-read-only-agent-context/
```

## Verification Before Commit

```text
npm run build && node --test dist/test/sandbox-policy.test.js
npm run build && node --test dist/test/sandbox-workspace.test.js
npm run build && node --test dist/test/daytona-environment.test.js dist/test/host-gate.test.js dist/test/preflight-runtime.test.js
npm run build && node --test dist/test/scaffold.test.js dist/test/daytona-claude.test.js dist/test/sandbox-policy.test.js
python3 .../validate_plugin.py plugins/harness-prep
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
npm run check
git diff --check
codex plugin add harness-prep@harnesskit
codex plugin list
```

Observed result:

```text
focused tests pass
Plugin validation passed
Skill is valid!
full check tests 566 pass 566 fail 0
diff check exit 0
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623081235
```

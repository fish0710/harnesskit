# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
77ea40877ee9852f751a92edf45c17d542bfc074
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers Daytona Agent workspace path clarification:

- distinguish Harness logical root `/workspace/candidate` from Daytona SDK path
  `workspace/candidate`;
- document that interactive Agent shell users should inspect
  `/home/daytona/workspace/candidate`;
- keep Claude native state and observability paths separate from the project
  workspace path;
- update harness-prep skill references and docs that guide run inspection;
- refresh and reinstall the local harness-prep Codex plugin cache.

## Key Files

```text
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/references/agent-environment.md
plugins/harness-prep/skills/harness-prep/references/observability-and-review.md
docs/usage.md
docs/architecture/daytona-sandbox-gate.md
src/harness/sandbox/environment.ts
src/harness/preflight.ts
src/harness/sandbox/workspace.ts
docs/superpowers/specs/2026-06-22-gate-readiness-barrier-design.md
docs/superpowers/plans/2026-06-11-daytona-sandbox-gate.md
docs/superpowers/plans/2026-06-15-daytona-claude-image-setup.md
docs/superpowers/plans/2026-06-17-daytona-claude-strong-resume.md
docs/superpowers/plans/2026-06-22-gate-readiness-barrier.md
docs/archive/2026-06-23-daytona-agent-workspace-path/
```

## Verification Before Commit

```text
npm run build
node --test dist/test/daytona-sandbox.test.js dist/test/daytona-environment.test.js dist/test/daytona-claude.test.js dist/test/sandbox-workspace.test.js
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
python3 .../validate_plugin.py plugins/harness-prep
codex plugin add harness-prep@harnesskit
```

Observed result:

```text
build exit 0
targeted tests pass: 110/110
Skill is valid!
Plugin validation passed
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623085251
```

Note: `dist/test/preflight-runtime.test.js` was not included in the final
targeted verification because the working tree contains an unstaged,
out-of-scope expectation change in `test/preflight-runtime.test.ts` that fails
against current implementation (`2 !== 3`). That file is intentionally excluded
from this commit.

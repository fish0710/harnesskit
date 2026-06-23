# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
264d10e698808572301438f1c817eba3b060d275
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers miniprogram gate stability and harness-prep skill guidance:

- wait for managed WeChat DevTools automation TCP readiness before running a
  host-local miniprogram runner;
- preserve minimal local DevTools environment forwarding;
- add regression coverage for the startup readiness race;
- document miniprogram gates as host-local contracts that consume compiled
  artifacts from candidate roots;
- document old/new miniprogram gates with distinct `autoPort` values;
- guide runners toward visible UI behavior and stable selectors;
- warn against `page.callMethod()` and raw `page.data()` coupling in
  uni-app/Vue outputs;
- update examples/miniprogram helpers and README;
- refresh and reinstall the local `harness-prep` plugin cache.

## Key Files

```text
src/plugins/miniprogram.ts
test/miniprogram-plugin.test.ts
test/miniprogram-templates.test.ts
examples/miniprogram/README.md
examples/miniprogram/test/gates/miniprogram-template-helpers.js
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/SKILL.md
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md
plugins/harness-prep/skills/harness-prep/references/gate-translation.md
docs/archive/2026-06-23-miniprogram-gate-stability/
```

## Verification Before Commit

```text
npm run check
npm run build
node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-templates.test.js
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
python3 .../validate_plugin.py plugins/harness-prep
codex plugin add harness-prep@harnesskit --json
git diff --check
```

Observed result:

```text
full suite: tests 555, pass 555, fail 0
targeted miniprogram tests: tests 54, pass 54, fail 0
Skill is valid!
Plugin validation passed
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623064758
git diff --check exit 0
```

## Residual Risk

This commit improves Harness startup sequencing and agent guidance. It does not
attempt to rewrite application-specific mini-program runners. Existing business
runners that assert compiled framework internals may still need project-level
changes following the new `miniprogram-gates.md` guidance.

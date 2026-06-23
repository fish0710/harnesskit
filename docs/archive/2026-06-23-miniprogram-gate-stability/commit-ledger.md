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

## Follow-up Commit: Host Preflight Doctor

Base commit before this follow-up:

```text
40e3bd46e1cac0c8cb0b9501bfa5f16be71ce224
```

Follow-up archive commit: the commit containing this section.

### Scope

This follow-up covers pre-Agent host readiness checks for miniprogram gates:

- add a host-local miniprogram DevTools doctor to Gate preflight;
- classify doctor failures as `hostLocal.<contract-id>.devtools`;
- warm managed DevTools with `cli islogin` before `cli auto`;
- cap managed DevTools command timeout independently from the full contract
  timeout;
- include `islogin` and `auto` command output in readiness diagnostics;
- document the preflight workflow in `harness-prep` and `examples/miniprogram`;
- validate the behavior against `/Users/zhongyy40/dev/miniprogram`.

### Key Files

```text
src/plugins/miniprogram.ts
src/harness/preflight.ts
test/miniprogram-plugin.test.ts
test/preflight-runtime.test.ts
test/preflight-render.test.ts
test/miniprogram-templates.test.ts
examples/miniprogram/README.md
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md
docs/archive/2026-06-23-miniprogram-gate-stability/
```

### Verification Before Commit

```text
npm run check
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
python3 .../validate_plugin.py plugins/harness-prep
codex plugin add harness-prep@harnesskit --json
harness preflight gate --dir contracts --config harness.config.json --stage mp-auto --json
harness check --dir contracts --config harness.config.json --stage mp-auto --json
git diff --check
```

Observed result:

```text
full suite: tests 568, pass 568, fail 0
Skill is valid!
Plugin validation passed
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623082128
/Users/zhongyy40/dev/miniprogram preflight: outcome ready
/Users/zhongyy40/dev/miniprogram check: fails on missing dist/build/mp-weixin, not DevTools WebSocket readiness
git diff --check exit 0
```

### Residual Risk

The doctor validates host DevTools automation readiness before Agent work. It
does not reconstruct unpublished candidate artifacts from failed Harness runs;
business workspaces still need their `projectPath` build output present before
the actual miniprogram UI gate can run.

## Follow-up Commit: Protocol Readiness And Doctor Cleanup

Base commit before this follow-up:

```text
e86ab5c
```

Follow-up archive commit: the commit containing this section.

### Review Findings

Local review found one important issue before commit: the implementation used
Node's global `WebSocket`, but the package supports Node `>=20` and
`npx -y node@20 -e "console.log(process.version, typeof WebSocket)"` returned
`v20.20.2 undefined`. The final implementation includes a raw TCP WebSocket
handshake fallback for Node 20.

### Scope

This follow-up covers the DevTools root-path regression shown by the real UI:

- wait for automation protocol readiness via `Tool.getInfo.SDKVersion`, not
  plain TCP port readiness;
- close the doctor DevTools session with `cli quit` after preflight;
- wait for `autoPort` release before removing the temporary doctor project;
- keep the doctor project directory if cleanup fails, avoiding a DevTools window
  pointing at a deleted path;
- add Node 20-compatible raw WebSocket handshake probing;
- document that preflight and actual mini-program gate must not race on the
  same `autoPort`.

### Key Files

```text
src/plugins/miniprogram.ts
test/miniprogram-plugin.test.ts
test/preflight-runtime.test.ts
examples/miniprogram/README.md
plugins/harness-prep/.codex-plugin/plugin.json
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
docs/archive/2026-06-23-miniprogram-gate-stability/
```

### Verification Before Commit

```text
npm run build && node --test dist/test/miniprogram-plugin.test.js
npm run build && node --test dist/test/miniprogram-plugin.test.js dist/test/preflight-runtime.test.js dist/test/miniprogram-templates.test.js
npm run check
npx -y node@20 -e "console.log(process.version, typeof WebSocket)"
harness preflight gate --dir contracts --json
harness check --dir contracts --json
python3 .../quick_validate.py plugins/harness-prep/skills/harness-prep
python3 .../validate_plugin.py plugins/harness-prep
git diff --check
```

Observed result:

```text
miniprogram-plugin targeted: tests 54, pass 54, fail 0
targeted miniprogram/preflight/templates: tests 70, pass 70, fail 0
full suite: tests 571, pass 571, fail 0
Node 20 WebSocket check: v20.20.2 undefined
/Users/zhongyy40/workspace/miniprogram-doctor-lab preflight: outcome ready
/Users/zhongyy40/workspace/miniprogram-doctor-lab check: outcome pass
post-preflight 9420 listener: none
Skill is valid!
Plugin validation passed
git diff --check exit 0
```

### Residual Risk

The doctor still necessarily launches local WeChat DevTools during host-local
preflight. Users should avoid running preflight and an actual mini-program gate
concurrently on the same `autoPort`.

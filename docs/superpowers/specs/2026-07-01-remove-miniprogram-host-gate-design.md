# Remove MiniProgram Host Gate Design

## Purpose

Remove the built-in WeChat mini-program host-local gate from Harness.

The feature was introduced to validate mini-program behavior on the macOS host
while Daytona agents and remote gates stayed sandboxed. Archive records show
that the feature required repeated hardening around DevTools startup,
automation readiness, temporary host workspaces, runner dependency injection,
artifact-first guidance, and preflight modeling checks. The operational result
is still too unstable and too specialized for the core Harness gate model.

The removal must be explicit and fail-closed. Existing `type: miniprogram`
contracts must not pass silently, and Harness guidance must stop producing new
mini-program host-local gates.

## Archive Evidence

The removal is grounded in these archived capabilities:

- `docs/archive/2026-06-17-miniprogram-host-gate/` introduced
  `type: miniprogram`, DevTools managed/connect modes, host candidate
  materialization, and mixed remote plus host-local aggregation.
- `docs/archive/2026-06-23-miniprogram-gate-stability/` added DevTools
  readiness waits, preflight doctor behavior, cleanup rules, and runner
  guidance after real host automation failures.
- `docs/archive/2026-06-24-miniprogram-artifact-first-defaults/` changed the
  default guidance to artifact-first mini-program validation.
- `docs/archive/2026-06-24-miniprogram-automator-toolchain/` added
  Harness-owned `miniprogram-automator@0.12.1` and `NODE_PATH` injection so
  runners would not install dependencies during the gate.
- `docs/archive/2026-06-25-preflight-hostlocal-review-ledger/` added static
  preflight detection for mini-program automation modeled as `type: command`.

These archives should remain as historical records. Current product docs,
templates, and prep guidance should no longer advertise the feature.

## Current Surface Area

Runtime and API surfaces to remove or rewrite:

- `src/plugins/miniprogram.ts`: DevTools config parsing, readiness probing,
  doctor project creation, managed/connect startup, runner execution, and
  `miniprogramPlugin`.
- `src/cli.ts`: built-in plugin import and registration.
- `src/index.ts`: public exports for `miniprogramPlugin` and host-local helpers
  that only exist for mini-program gates.
- `src/contracts.ts`: `miniprogram` required fields.
- `src/harness/preflight.ts`: host-local readiness, DevTools doctor calls, and
  mini-program command-modeling lint.
- `src/harness/sandbox/environment.ts`: host-local contract split and
  `runHostLocalGate()` execution path.
- `src/harness/host-gate.ts`: temporary host candidate materialization if no
  other host-local contract type remains.
- `package.json` and `package-lock.json`: `miniprogram-automator` dependency.

Documentation and scaffolding surfaces to update:

- `README.md`
- `docs/usage.md`
- `docs/architecture/gate-plugin-guide.md`
- `docs/architecture/daytona-sandbox-gate.md`
- `src/harness/scaffold.ts`
- `plugins/harness-prep/skills/harness-prep/SKILL.md`
- `plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md`
- `plugins/harness-prep/skills/harness-prep/references/contracts-and-config.md`
- `plugins/harness-prep/skills/harness-prep/references/gate-translation.md`
- `plugins/harness-prep/skills/harness-prep/references/blocker-analysis.md`
- `plugins/harness-prep/skills/harness-prep/references/source-evidence.md`
- `examples/miniprogram/`

Tests and fixtures to remove or rewrite:

- `test/miniprogram-plugin.test.ts`
- `test/miniprogram-cli.test.ts`
- `test/miniprogram-templates.test.ts`
- Mini-program-specific cases in `test/host-gate.test.ts`,
  `test/daytona-environment.test.ts`, `test/preflight-runtime.test.ts`,
  `test/loader-selector.test.ts`, and `test/remote-gate.test.ts`
- `test/fixtures/mp-project/`
- `test/fixtures/miniprogram-runner.js`

## Desired Behavior After Removal

`type: miniprogram` is not a supported built-in contract type.

When a repository still contains a `type: miniprogram` contract, Harness should
fail during contract validation with a clear error:

```text
type="miniprogram" has been removed from Harness. Use an external CI check,
type="command" for remote-executable checks, or type="review" for manual
approval.
```

This validation-time error is preferred over relying only on GateCore's unknown
plugin error because it gives users an immediate migration reason before any
gate execution path starts.

`harness preflight gate` should no longer run host-local readiness checks or
DevTools doctor logic. Its report shape may keep `hostLocalContracts: []` for
JSON compatibility, but selected contracts should all be treated as remote or
invalid. Pretty output should not mention host-local mini-program coverage.

`harness run` should no longer materialize agent candidates into a host
temporary workspace for gate execution. All machine gates should execute in the
normal Gate sandbox. Review gates remain host-classified by GateCore but are
not host-local machine execution.

## Migration Guidance

Projects using mini-program behavior gates should choose an explicit
replacement outside the Harness core:

- Use external CI or a project-owned script for WeChat DevTools automation.
- Use `type: command` only for checks that can execute inside the Gate sandbox,
  such as artifact existence checks, lint, tests, or source reproducibility.
- Use `type: review` when the behavior requires human or host GUI judgment.

Harness should not provide a generic `hostLocal: true` command escape hatch as
part of this removal. That would preserve the same unstable host execution
model under a less explicit name.

## Implementation Strategy

Use a hard removal rather than a deprecation stub:

1. Add tests that assert `type: miniprogram` validation fails with the removal
   message, and that built-in plugin registration no longer includes
   `miniprogram`.
2. Remove `src/plugins/miniprogram.ts`, CLI/API exports, schema required fields,
   host-local split execution, DevTools preflight, and mini-program command
   modeling lint.
3. Remove `miniprogram-automator` from dependencies and refresh the lockfile.
4. Delete mini-program examples, runners, fixtures, and dedicated tests.
5. Rewrite docs and harness-prep references so they do not instruct agents to
   create mini-program host-local gates.
6. Preserve archive docs and historical design docs unchanged unless links in
   current docs need to label them as archived history.

The implementation should avoid unrelated refactors. If `host-gate.ts` becomes
unused after removing the only host-local type, delete it rather than leaving an
empty extension point.

## Compatibility

This is a breaking change for repositories with `type: miniprogram` contracts
and for external consumers importing `miniprogramPlugin` or host-local helper
exports from the package root.

The break is intentional. The safer compatibility behavior is an explicit
validation error for old contracts, not a stub plugin that remains visible in
the built-in type list.

Keeping `hostLocalContracts` in preflight JSON as an always-empty array is
acceptable to avoid unnecessary report-shape churn. It does not imply that
host-local gates are supported.

## Testing

Targeted verification should include:

- Contract validation rejects `type: miniprogram` with the removal message.
- `buildGate()` and CLI checks no longer register `miniprogram`.
- Unknown plugin handling still fails closed for unsupported types.
- Daytona run tests cover ordinary remote contracts after the host-local split
  is removed.
- Gate preflight still reports static/runtime readiness for ordinary remote
  contracts.
- Documentation/template tests no longer expect mini-program guidance.
- Package build succeeds without `miniprogram-automator`.

Run sequence:

```bash
npm run build
node --test dist/test/loader-selector.test.js dist/test/gate.test.js dist/test/cli-entrypoint.test.js
node --test dist/test/preflight-runtime.test.js dist/test/daytona-environment.test.js
npm run check
git diff --check
```

If existing Daytona tests require external credentials or services, keep the
normal unit suite as the required local gate and classify Daytona integration
commands separately.

## Risks

- Existing user repositories with mini-program contracts will need manual
  migration.
- Removing root exports can break downstream TypeScript imports at compile
  time.
- Documentation drift is the largest practical risk: any remaining harness-prep
  reference to `miniprogram` could cause agents to regenerate the removed
  feature shape.
- Broad test deletion can hide regressions if mixed gate behavior had been
  covering generic candidate publication paths. Keep remote-only Daytona
  publication tests intact.

## Acceptance

The removal is complete when:

- No production source imports or exports `miniprogramPlugin`.
- No runtime code starts WeChat DevTools, probes a mini-program WebSocket, or
  injects `HARNESS_MINIPROGRAM_*`.
- No package dependency on `miniprogram-automator` remains.
- Current docs, scaffold output, examples, and harness-prep references no
  longer recommend `type: miniprogram`.
- Old mini-program contracts fail validation with an explicit removed-feature
  message.
- The full local test suite passes.

# Contracts And Config

## Contract Selection Rules

Prefer gates that produce actionable failures:

- `command`: build, test, lint, typecheck, migration check, CLI behavior.
- `http`: black-box API status/body/header checks. Start services in `sandbox.gateSetup`.
- `structure`: eslint, dependency-cruiser, import-linter, SwiftLint, or similar structural tools.
- `boot`: simple startup smoke when no better service readiness check exists.
- `miniprogram`: WeChat mini-program host-local automation.
- `review`: product, UX, compatibility, migration, or risk decisions that a machine must not decide.

Every contract should include a stable `id`, clear `scenario`, and `ref` pointing to the spec or decision doc when useful.

Before picking commands, read `sandbox-snapshots.md`. Default Daytona Agent/Gate snapshots have Node/npm/npx and Python, but no `git`, `pnpm`, `yarn`, or `bun`; Gate has no `claude`.

## Command Contract

```yaml
id: test.unit
type: command
scenario: Unit tests must pass for the changed behavior.
cmd: npm
args: ["test"]
expectExit: 0
timeoutMs: 120000
ref: docs/specs/<date>-<slug>.md
```

## HTTP Contract

Use `gateSetup` to start the service before this contract runs.

```yaml
id: api.health
type: http
scenario: Health endpoint returns an OK status payload.
trigger:
  method: GET
  baseUrl: "http://127.0.0.1:3000"
  path: /health
  timeoutMs: 30000
expect:
  status: 200
  body_contains:
    status: ok
ref: docs/specs/<date>-<slug>.md
```

## Structure Contract

```yaml
id: lint.eslint
type: structure
scenario: Source must satisfy eslint rules.
tool: npx
args: ["eslint", "--format", "json", "src"]
parse: eslint-json
expectExit: 0
timeoutMs: 120000
```

## MiniProgram Contract

Mini-program gates run on the host because WeChat DevTools is a local macOS
tool. Read `miniprogram-gates.md` before writing the contract or runner.

```yaml
id: mp.behavior
type: miniprogram
scenario: 小程序关键用户路径应保持可用
projectPath: dist/build/mp-weixin
runner: test/gates/mp-behavior-runner.js
devtools:
  mode: managed
  cliPath: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
  autoPort: 9420
  trustProject: true
timeoutMs: 240000
expectExit: 0
ref: docs/specs/<date>-<slug>.md
```

Rules:

- `projectPath` must point at the compiled mini-program artifact that contains
  `project.config.json`, not at source pages.
- For mini-program behavior tasks, default to Agent-built artifacts and
  `gateSetup: []`; do not make dependency install or rebuild commands the
  default Gate path.
- Framework-specific rebuilds, including uni-app, Taro, or native mini-program
  build commands, belong in optional `type: command` contracts for source
  reproducibility. They are not part of the `miniprogram` plugin contract.
- Use a unique `autoPort` per concurrently selected mini-program contract.
- Keep `test/gates` protected. The runner is a trusted host-side judge.
- In runners, avoid `page.callMethod()` and raw `page.data()` assertions for
  uni-app/Vue outputs; assert routes, text, stable selectors, and user-visible
  state instead.

## Review Contract

Use `review` for decisions that require the user's judgment. This intentionally blocks `harness run` with exit code 2 until resolved.

```yaml
id: product.behavior-review
type: review
scenario: User must confirm the intended behavior before merge.
question: "Does this behavior match the accepted product requirement?"
focalPoints:
  - "Does the new behavior preserve existing supported workflows?"
  - "Is any changed behavior intentional and documented?"
evidence:
  - label: "Spec"
    value: "docs/specs/<date>-<slug>.md"
options:
  - id: approve
    label: "Approve the behavior"
    resolvesTo: pass
  - id: reject
    label: "Reject and send back for changes"
    resolvesTo: fail
recommended: reject
```

Resolve after review:

```bash
harness review --resolve product.behavior-review --option approve --by "<name>" --reason "<why>"
```

## harness.config.json Template

Only put implementation-owned paths in `candidateRoots`. Put task context and setup manifests in `readOnlyPaths` when the implementation agent needs to read them but must not publish changes. Keep contracts, trusted gate runners, config, CI, and Harness state in `protectedPaths`.

```json
{
  "baseline": ["test.unit"],
  "rules": [
    { "when": ["src/**"], "select": ["lint.eslint"] }
  ],
  "sandbox": {
    "candidateRoots": [
      "src",
      "test",
      "dist/build/mp-weixin"
    ],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates"
    ],
    "readOnlyPaths": [
      "AGENTS.md",
      "docs/specs",
      "docs/plans",
      "docs/reference",
      ".nvmrc",
      "package.json",
      "package-lock.json",
      "babel.config.js",
      "postcss.config.js",
      "tsconfig.json"
    ],
    "agentSetup": ["npm ci"],
    "gateSetup": [],
    "limits": {
      "maxFiles": 10000,
      "maxFileBytes": 10485760,
      "maxTotalBytes": 209715200
    },
    "retainOnFailure": false
  },
  "series": {
    "id": "<safe-series-id>"
  },
  "taskDefaults": {
    "gate": {
      "contracts": ["test.unit"]
    }
  },
  "autoCommit": {
    "enabled": true,
    "messageTemplate": "harness: {index}/{total} {id}"
  },
  "tasks": [
    {
      "id": "<safe-task-id>",
      "task": "Implement the confirmed task. Read docs/specs/<date>-<slug>.md and do not edit protected Harness files.",
      "gate": {
        "contracts": ["test.unit", "lint.eslint"]
      }
    }
  ]
}
```

Rules:

- Task ids and series ids must be safe path segments: no `/`, `\`, `.`, `..`, empty string, or NUL.
- If using `tasks`, prefer explicit task gate contracts over changed-file selection.
- Do not include `contracts`, `.harness`, or `harness.config.json` in mutable roots unless the user is explicitly doing Harness configuration work before the run.
- Do not include `AGENTS.md`, `docs/specs`, `docs/plans`, or
  `docs/reference` in mutable roots. Put them in `readOnlyPaths` so the
  implementation agent can read task and runtime context without changing it.
- Include compiled mini-program artifact roots such as `dist/build/mp-weixin`
  or `vue3-app/dist/build/mp-weixin` in `candidateRoots` when later
  host-local mini-program gates must consume agent-built artifacts.
- For default mini-program behavior gates, let the implementation Agent produce
  the compiled artifact and keep `gateSetup` empty. Add Gate-side install/build
  commands only for explicit source reproducibility requirements.
- Do not include root `package.json`, lockfiles, `.nvmrc`, or build config in
  mutable roots when they are only setup inputs or legacy baseline. Put them in
  `readOnlyPaths` if Agent setup must read them, or `protectedPaths` only when
  the Agent does not need them.
- If a task intentionally changes dependencies, include the package manifest and
  lockfile together in `candidateRoots`, scope setup commands to that project
  root, and tell the user this makes dependency changes part of the candidate.
- If `agentSetup` or `gateSetup` requires credentials, stop and ask for a safer env-based setup.
- If setup uses `nvm`, write `bash -lc 'source /usr/local/nvm/nvm.sh && nvm use <version> && ...'`. Plain `nvm use` is invalid in these sandboxes.
- If a command/http contract needs tools absent from the Gate snapshot, install them in `gateSetup` before Gate network policy is applied.
- Treat a Gate preflight readiness error as contract/config failure. Fix it before running an implementation agent.

## Validation

Before execution:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json
harness preflight gate --dir contracts --config harness.config.json
```

Freeze stable contracts only after the user confirms they are the intended judging rules:

```bash
harness contract freeze contracts/<contract>.yaml
```

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

Keep protected paths broad. Only put implementation-owned paths in `candidateRoots`.

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
      "package.json",
      "package-lock.json",
      "tsconfig.json"
    ],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates"
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
- If `agentSetup` or `gateSetup` requires credentials, stop and ask for a safer env-based setup.
- If setup uses `nvm`, write `bash -lc 'source /usr/local/nvm/nvm.sh && nvm use <version> && ...'`. Plain `nvm use` is invalid in these sandboxes.
- If a command/http contract needs tools absent from the Gate snapshot, install them in `gateSetup` before Gate network policy is applied.

## Validation

Before execution:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json
```

Freeze stable contracts only after the user confirms they are the intended judging rules:

```bash
harness contract freeze contracts/<contract>.yaml
```

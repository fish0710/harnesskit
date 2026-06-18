# Natural-Language Gate Translation

Use this whenever the user describes acceptance criteria, "must not break" rules, or manual review expectations.

## Reliability Basis

Harness contracts are typed plugin inputs. Each contract needs `id` and `type`; unknown or malformed contracts fail closed as `error`. Automatic contracts should decide only what can be observed mechanically. Human judgment belongs in `review`, which blocks with exit code 2 until the user records a verdict.

## Translation Flow

For every user-described gate, write a gate draft before writing YAML:

| Field | Question |
|---|---|
| Requirement | What must be true? |
| Observable evidence | What command, HTTP response, static analysis output, property, or human decision proves it? |
| Contract type | `command`, `http`, `structure`, `boot`, `invariant`, `miniprogram`, or `review` |
| Required setup | Does Agent or Gate need install, build, service start, fixture, devtool, database, or env? |
| Pass condition | Exact exit code, response, status/body/header, lint result, or review option |
| Fail condition | What means the implementation is wrong? |
| Error condition | What means the gate was misconfigured or could not run? |
| Reference | Spec, ADR, issue, or decision doc |

If evidence or setup is unclear, ask the user. Do not guess contract fields.

## Decision Tree

- "Build/typecheck/test/lint must pass" -> `command`.
- "CLI command should print/exit correctly" -> `command` with explicit `cmd`, `args`, `expectExit`.
- "Endpoint returns status/body/header" -> `http`, and add service start to `sandbox.gateSetup`.
- "Service starts quickly" -> `boot` only for simple startup checks; prefer `gateSetup` + `http` for readiness.
- "No forbidden imports/layers/dependencies" -> `structure` with an existing analyzer, or `command` if the project already has a script.
- "Property must hold for generated samples" -> `invariant` only if a host properties module exists and can be passed with `--properties`.
- "WeChat mini-program user flow" -> `miniprogram` with project path, runner, DevTools mode, timeout.
- "Product owner must approve", "UX feels right", "migration risk acceptable", "is this intentional behavior change?" -> `review`.
- "Agent should decide if this is okay" -> usually `review`; do not encode subjective approval as `cmd: true`.

## Contract Authoring Rules

- Use stable ids such as `api.health`, `lint.eslint`, or `product.behavior-review`.
- Include `scenario` in user language so gate feedback has a useful `why`.
- Include `ref` to the spec or decision doc when possible.
- Use `timeoutMs` for commands or external tools that can hang.
- Keep gate runner files protected if they are trusted judging assets.
- For HTTP gates, `trigger.baseUrl` points inside the Gate sandbox. Start the service there.
- For review gates, include at least one pass option and one fail option.

## Translation Examples

Natural language:

```text
The health endpoint must return 200 and JSON {status:"ok"}.
```

Translate to:

```yaml
id: api.health
type: http
scenario: Health endpoint returns OK JSON.
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

And ensure:

```json
{
  "sandbox": {
    "gateSetup": ["npm ci", "npm run start:test -- --port 3000"]
  }
}
```

Natural language:

```text
If the response format changes, I need to decide whether that is intended.
```

Translate to:

```yaml
id: product.response-format-review
type: review
scenario: Response format changes require human product approval.
question: "Is the response format change intentional and approved?"
focalPoints:
  - "Are existing clients compatible with the new response?"
  - "Is the new shape documented in the spec or API docs?"
evidence:
  - label: Spec
    value: docs/specs/<date>-<slug>.md
options:
  - id: approved
    label: "Approved intentional change"
    resolvesTo: pass
  - id: regression
    label: "Treat as regression"
    resolvesTo: fail
recommended: regression
```

## Validation Loop

After writing contracts:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
```

Classify failures:

- `error`: configuration/runtime problem. Fix before running an agent.
- `fail`: the current implementation violates the intended gate. This may be an expected red gate.
- `blocked`: a `review` decision is pending. Get user decision before claiming readiness.

Only start `harness run` when there are no `error` results.

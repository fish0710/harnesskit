# Reliability Checks

Use this before claiming the plugin can carry a user from natural-language request to Harness execution.

## Source-Backed Claims

| Capability | Harness evidence | Skill enforcement |
|---|---|---|
| Step-by-step create -> config -> check -> run -> review | `docs/usage.md` defines the create/check/run/review flow | `prep-workflow.md` and `run-supervision.md` |
| Agent/Gate environment control | `harness.config.json` owns `candidateRoots`, `protectedPaths`, `agentSetup`, `gateSetup`, and limits | `agent-environment.md` |
| Agent/Gate snapshot toolchain awareness | `src/harness/sandbox/toolchain.ts` pins default snapshots; snapshot scripts preflight latest sandboxes | `sandbox-snapshots.md` |
| Natural-language gates become typed contracts | GateCore dispatches by `type`; plugins classify `pass/fail/error/needs_review` | `gate-translation.md` and `contracts-and-config.md` |
| Human review stops automation | `review` contracts produce `needs_review`; aggregate outcome becomes `blocked` | `gate-translation.md`, `run-supervision.md`, `observability-and-review.md` |
| Behavior is observable after run | RunStore v3 records store kind, selected contracts, attempts, sandbox ids, session ids, logs, report, publication, outcomes, and observability config | `runstore-observability.md`, `observability-and-review.md`, `blocker-analysis.md` |
| Daytona Claude artifacts can be inspected | Claude runs persist `.claude` in the run-scoped Daytona volume when observability is enabled | `observability-and-review.md` |
| Publication is separate from git | Run pass publishes evaluated candidate bytes; series may auto-commit separately | `run-supervision.md`, `blocker-analysis.md` |

Before using this table externally, read `source-evidence.md` and re-check any drift-prone claim against the current Harness source. This table is a capability summary; `source-evidence.md` is the evidence index.

## Capability Checklist

Before starting `harness run`, verify:

- [ ] `harness create .` has created or existing Harness files have been read and merged.
- [ ] `docs/specs/<date>-<slug>.md` states goal, non-goals, must-preserve principles, decisions, gates, and risks.
- [ ] `docs/plans/<date>-<slug>.md` has a task list or task series.
- [ ] Environment inventory is complete: CLI, install/build/test, service ports, candidate roots, protected paths, secrets, Daytona/Claude env, local tools, and Agent/Gate snapshot tool availability.
- [ ] Every user acceptance criterion maps to a contract or a documented non-goal.
- [ ] Every subjective decision maps to `review`.
- [ ] HTTP gates have matching `gateSetup` or a justified external target.
- [ ] `harness contract validate contracts` succeeds.
- [ ] `harness check --dir contracts --config harness.config.json --json` has no unexpected `error`.
- [ ] User has confirmed the summary and exact run command.

During or after run, verify:

- [ ] Latest `.harness/runs/<runId>.json` was inspected.
- [ ] Prefer `harness runs list/show --json`; use raw files only as fallback.
- [ ] Agent sandbox id, Gate sandbox ids, and attempt outcomes were separated in the explanation.
- [ ] For series, parent `kind=series`, child `kind=series-task`, and `.harness/series` ledger were not confused.
- [ ] `blocked` was handled through `harness review`, not by guessing.
- [ ] `escalated` was analyzed through timeline evidence before changing attempts or contracts.
- [ ] Publication and git commit state were reported separately.

## Pressure Scenarios For Future Testing

Run these in a fresh agent thread when validating the skill behavior:

1. Natural language API gate:
   - User says: "Create a project. The health endpoint must return 200 JSON ok, but I do not know how to write contracts."
   - Expected: agent asks for service start/port if missing, writes `http` contract, adds `gateSetup`, validates contracts, summarizes before run.

2. Sandbox environment ambiguity:
   - User says: "Let Claude implement this Node feature."
   - Expected: agent collects package manager, install command, candidate roots, protected paths, Daytona/Claude env names, and refuses to write secrets into config.

3. Human review:
   - User says: "If the API response shape changes, I need to decide if it is intentional."
   - Expected: agent writes a `review` contract with pass/fail options and later uses `harness review`.

4. Stuck run:
   - User says: "Harness stopped, what happened?"
   - Expected: agent reads `.harness/runs`, review items, series ledger if present, and explains blocker by host/agent/gate/publication/git surface.

5. Misleading gate failure:
   - Gate says only `fetch failed`.
   - Expected: agent checks HTTP target, `gateSetup`, port mismatch, and run manifest before telling the implementation agent to retry.

Passing schema validation is necessary but not sufficient. A production-ready release should also pass these pressure scenarios.

## Evidence Quality Levels

- Strong: directly backed by current source code or tests, for example `src/gate.ts`, `src/aggregate.ts`, `src/harness/run.ts`, `src/harness/record.ts`, or focused tests.
- Medium: backed by checked-in architecture or usage docs and consistent with source-level behavior.
- Weak: inferred workflow guidance. Keep it out of contract/config generation unless the user confirms it or local repo inspection proves it.

When reporting reliability to the user, separate these levels. Do not claim an end-to-end behavior was proven unless a real or simulated run exercised it.

---
name: harness-prep
description: Use when preparing a Harness project or run from a user's natural-language request, including harness create, requirements/spec/design gathering, contracts, harness.config.json, task series, gate review decisions, Daytona/Claude observability, or starting harness run.
---

# Harness Prep

## Core Rule

Act as the preparation layer before Harness execution. The user should make product and risk decisions; the agent should create and explain the Harness files.

Do not start `harness run` until the user has confirmed the generated requirement spec, task checklist, gate contracts, and `harness.config.json` plan.

During execution, keep the user oriented around the real Harness state: host manifest, Agent sandbox, Gate sandbox, publication, and git history are separate surfaces.

## Load The Right Reference

- For a new project or new task: read `references/prep-workflow.md`.
- Before writing `harness.config.json` sandbox fields or run env guidance: read `references/agent-environment.md`.
- Before choosing `agentSetup`, `gateSetup`, package-manager commands, shell wrappers, or Daytona snapshot overrides: read `references/sandbox-snapshots.md`.
- When translating natural-language gates into contracts: read `references/gate-translation.md`.
- When writing contracts or `harness.config.json`: read `references/contracts-and-config.md`.
- When preparing WeChat mini-program gates or runners: read `references/miniprogram-gates.md`.
- Before starting or supervising `harness run`: read `references/run-supervision.md`.
- When the user asks "where is it now?", a run blocks, or a gate needs human review: read `references/observability-and-review.md`.
- When reading persisted run records or explaining RunStore state: read `references/runstore-observability.md`.
- When diagnosing stuck runs, failed gates, or escalation: read `references/blocker-analysis.md`.
- When grounding claims in current Harness behavior: read `references/source-evidence.md`.
- Before claiming this plugin covers a workflow end to end: read `references/reliability-checks.md`.

## Operating Boundaries

- Prefer `harness` on PATH. If working inside the Harness source repo, build first and use `node dist/src/cli.js`.
- Run `harness create .` only in the target project root. Do not use `--force` unless the user explicitly approves overwriting existing Harness files.
- Keep `contracts/`, `test/gates/`, `harness.config.json`, `.github/workflows/`, `CODEOWNERS`, and `.harness/` host-owned and hidden from the implementation agent during `harness run`.
- Put `AGENTS.md`, `docs/specs/`, and `docs/plans/` in `sandbox.readOnlyPaths` so the implementation agent can read task context without publishing changes to it.
- Never write API keys, model tokens, or Daytona credentials into repo files. Ask the user to export environment variables or pass them through the shell.
- If the user wants Claude Code execution, use `--driver claude`. If the user wants Codex execution, use `--driver command --agent-cmd <runner>` only when a real Codex runner command exists; do not invent a `--driver codex` flag.
- Explain generated config in natural language before asking for confirmation.

## Required Preparation Artifacts

Before execution, produce or update:

- `AGENTS.md` from `harness create`, plus any repo-specific notes it points to.
- `docs/specs/<date>-<slug>.md`: current requirement, non-goals, must-preserve principles, decisions, risks, acceptance mapping.
- `docs/plans/<date>-<slug>.md`: task checklist that can be translated into `harness.config.json` tasks.
- `contracts/*.yaml|json`: executable gates where possible and `review` gates for human-only decisions.
- `harness.config.json`: baseline/rules, sandbox policy, optional task series, task-specific gates, and auto commit policy.
- `CODEOWNERS` and `.github/workflows/harness-gate.yml` from `harness create`, adjusted only after user confirmation.

## User Interaction Pattern

1. Inspect the repo and existing Harness files.
2. Inventory the Agent/Gate environment and decide candidate, read-only, and protected paths.
3. Ask one missing-requirement question at a time.
4. Convert answers into files, not chat-only notes.
5. Translate each acceptance criterion into an automatic contract or a `review` contract.
6. Show the user a concise confirmation summary:
   - requirement
   - non-goals
   - must-preserve principles
   - Agent setup and Gate setup
   - task list
   - gates that will block automatically
   - gates that require human review
   - mutable candidate roots, read-only context paths, and protected paths
   - exact command that will run
7. After confirmation, validate contracts/config and only then start the requested run.

## Pre-run Checklist

Run the strongest useful host validation for the task scope:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness status --dir contracts
```

When the task has a known file scope, prefer targeted contract selection instead
of running every contract:

```bash
harness check --dir contracts --config harness.config.json --changed path/a,path/b --json
```

If the project uses the source checkout CLI:

```bash
npm run build
node dist/src/cli.js contract validate contracts
node dist/src/cli.js check --dir contracts --config harness.config.json --json
```

`harness check` proves local contract behavior on the host. Daytona-backed
`harness run` enforces Gate readiness preflight before creating an Agent
sandbox, so a separate manual `harness preflight gate` is optional diagnostic
work, not a required extra step. Run it manually only when early setup feedback
is worth the duplicate Gate sandbox work, for example after changing
`gateSetup`, contract commands, Gate snapshot selection, or loopback service
startup assumptions.

For configured task series, inspect `.harness/series/<series-id>.json` before
assuming `harness run` will start work. If every relevant task is already
`completed` with the same `taskHash`, `harness run` will skip those tasks before
creating an Agent, creating a Gate sandbox, or triggering the built-in preflight.
That skip is expected resume behavior, not a failed run.

If checks fail because the project is not implemented yet, separate "expected red gate" from config errors. Contract syntax errors, missing commands, unsafe paths, or missing setup commands must be fixed before `harness run`.

Do not treat `harness check` failure as acceptable pre-run evidence unless every failure is an intended product-red gate and there are zero `error` results.

## Execution

For configured task series:

```bash
harness run --driver claude --max-attempts 3
```

For a single confirmed task:

```bash
harness run "<confirmed task text>" --driver claude --max-attempts 3
```

For a real command-based agent:

```bash
harness run "<confirmed task text>" --driver command --agent-cmd "<repo-approved runner>"
```

If the user asks for a dry run, use the default scaffold driver and say clearly that it will not change code.

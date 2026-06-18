# Harness Preparation Workflow

## 1. Find The Target And CLI

Confirm the target repository root before writing files.

Use this order for the Harness command:

1. `harness` if available on PATH.
2. In the Harness source repo: `npm run build`, then `node dist/src/cli.js`.
3. If neither exists, ask for the Harness CLI path or install instruction.

Initialize only after checking for existing files:

```bash
harness create .
```

If existing files were skipped, read them and merge with them. Do not run `harness create --force` unless the user explicitly confirms overwriting.

## 2. Interview The Requirement

Ask one question at a time. Stop asking when these fields are known enough to write a useful spec:

- Goal: what user-visible or system-visible outcome must exist.
- Non-goals: what must not be changed in this run.
- Must-preserve principles: compatibility, performance, security, data shape, UI behavior, public API, deployment assumptions.
- Target files or modules, if known.
- Environment needed to validate the change.
- Automatic gates that can decide pass/fail.
- Human review points that must block until the user decides.
- Preferred execution agent: Claude Code, Codex command runner, or dry-run scaffold.

## 3. Write The Spec

Create `docs/specs/<date>-<slug>.md` with this shape:

```markdown
# <Requirement Name>

## Current Request

<One paragraph in the user's language.>

## Goal

- <Observable outcome>

## Non-goals

- <Out of scope behavior>

## Must Preserve

- <Principle or invariant>

## User Decisions

| Decision | Current answer | Blocks execution? |
|---|---|---|
| <question> | <answer or pending> | yes/no |

## Functional Checklist

- [ ] <feature or behavior>

## Gate Mapping

| Requirement | Contract id | Gate type | Human review? |
|---|---|---|---|
| <requirement> | <contract.id> | command/http/structure/review | yes/no |

## Risks

- <Risk and mitigation>
```

Use pending only while interviewing. Do not leave pending entries before starting `harness run`.

## 4. Write The Plan

Create `docs/plans/<date>-<slug>.md`. Keep tasks small enough for one agent run each. If the work has more than one meaningful subtask, reflect it in `harness.config.json` `tasks`.

Plan shape:

~~~markdown
# <Requirement Name> Execution Plan

## Task Series

1. `<task-id>`: <agent-facing task>
   - Candidate roots: <paths>
   - Gates: <contract ids>
   - Done when: <observable result>

## Manual Decisions

- `<review-contract-id>`: <what the user must decide>

## Run Command

```bash
harness run --driver claude --max-attempts 3
```
~~~

## 5. Confirmation Summary

Before running, tell the user:

- "I will let the agent modify only: ..."
- "I will protect: ..."
- "Automatic gates are: ..."
- "Human review gates are: ..."
- "The exact command will be: ..."

Wait for confirmation. If the user changes anything, update files first, then summarize again.

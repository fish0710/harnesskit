# Serial Tasks And Auto Commit Design

> Status: approved design draft
>
> Date: 2026-06-17
>
> Scope: config-driven `harness run` task series, per-task gates, resume
> metadata, automatic host commits, and `harness create` git initialization

## Problem

Harness can run one production task at a time. That is too coarse for large
changes such as a project refactor. A single Claude Code task can exceed the
useful context and control surface, while manually running dozens of smaller
tasks loses orchestration, recovery, and commit discipline.

The missing capabilities are:

- serial execution of many planned tasks from `harness.config.json`;
- a reliable marker for tasks that already completed before interruption;
- task-specific gate selection, because each subtask has different acceptance
  criteria;
- automatic git commits after each gate-approved publication;
- `harness create .` should initialize git when the target directory is not a
  git repository.

## Goals

- Keep existing single-task `harness run "<task>"` behavior unchanged.
- Let `harness run --driver claude` with no task argument read a task series
  from `harness.config.json`.
- Run tasks strictly in order and stop on the first blocked, escalated, failed,
  or ambiguous state.
- Use a fresh Agent sandbox and fresh Claude session for each task.
- Keep retry attempts inside one task on the existing strong-resume model:
  same task, same Agent sandbox, same Claude session.
- Select gates per task through explicit contract ids and/or contract stages.
- Record series progress in host-owned state so completed tasks are skipped on
  resume.
- Commit only the gate-published files for the completed task.
- Avoid committing `.harness` run records, series ledgers, or unrelated user
  changes as part of automatic task commits.
- Initialize git during `harness create` when the target directory is outside a
  git worktree.

## Non-goals

- Do not let agents modify contracts, verdicts, `harness.config.json`, CI, or
  other protected assets during task execution.
- Do not auto-generate contracts during the serial run.
- Do not skip failed tasks and continue later tasks.
- Do not push, merge, open PRs, or approve CI.
- Do not reuse one Claude conversation across different task ids.
- Do not make `harness fix` consume the configured series in the first
  implementation.

## Command Semantics

Existing single-task mode remains the same:

```bash
harness run "implement health check" --driver claude
```

Serial mode is selected only when `run` has no positional task and the loaded
config contains a non-empty `tasks` array:

```bash
harness run --driver claude --max-attempts 3
```

If no positional task is provided and no configured tasks exist, Harness prints
a usage error. This avoids silently running a default task.

The CLI flags still apply to every task in the series unless overridden by a
task-specific field. For example, `--driver claude`, `--max-attempts 3`,
`--dir contracts`, `--properties`, and `--base-url` are shared run settings.

## Configuration Model

The first implementation adds top-level series fields to
`harness.config.json`. They do not change the existing `baseline`, `rules`, or
`sandbox` semantics.

```json
{
  "series": {
    "id": "order-refactor"
  },
  "taskDefaults": {
    "gate": {
      "contracts": ["smoke.boot"]
    }
  },
  "autoCommit": {
    "enabled": true,
    "messageTemplate": "harness: {id}"
  },
  "tasks": [
    {
      "id": "extract-domain-model",
      "task": "Extract the order domain model.",
      "gate": {
        "contracts": ["domain.model-boundary"]
      }
    },
    {
      "id": "split-services",
      "task": "Split service-layer responsibilities.",
      "gate": {
        "stage": "service-refactor"
      }
    }
  ]
}
```

### `series.id`

`series.id` is an optional safe path segment used for the progress file path.
If omitted, it defaults to `default`.

Progress is stored at:

```text
.harness/series/<series-id>.json
```

The id must be non-empty and must not contain `/`, `\`, NUL, `.`, or `..`.

### `tasks`

Each task requires:

- `id`: a stable safe identifier unique within the series;
- `task`: the prompt passed to the selected Agent for this subtask.

Each task may define:

- `gate`: task-specific gate selector;
- `commitMessage`: exact commit subject override.

Task ids are operational identifiers. Users should not rename a completed task
unless they want Harness to treat it as a new task.

### `taskDefaults.gate`

`taskDefaults.gate` is optional and applies to every task. It is merged with
the task's own `gate` selector.

### `autoCommit`

`autoCommit.enabled` defaults to `true` for serial mode. When enabled, Harness
creates one git commit after each completed task.

`messageTemplate` defaults to:

```text
harness: {id}
```

Supported placeholders:

- `{id}`: task id;
- `{index}`: one-based task index;
- `{total}`: total task count.

The final implementation may add more placeholders later, but unknown
placeholders must fail config validation instead of being left in the commit
message.

## Task-level Gate Selection

Serial task gates are plan-driven. They should not primarily depend on changed
files, because a planned task's final changed files are unknown before it runs.

A gate selector supports:

```json
{
  "contracts": ["smoke.boot", "domain.model-boundary"],
  "stage": "service-refactor"
}
```

Selection rules:

1. Start from `taskDefaults.gate`.
2. Merge the task's own `gate`.
3. Expand `contracts` by exact contract id.
4. Expand `stage` by matching each contract's `stage` field.
5. Deduplicate while preserving config order first, then contract file order for
   stage expansion.
6. Fail closed if any explicit contract id does not exist.
7. Fail closed if a selector resolves to zero contracts.

If neither defaults nor the task define a gate selector, the task falls back to
the current single-run behavior:

- CLI `--stage` selects contracts by stage;
- otherwise all loaded contracts run.

This keeps compatibility while encouraging explicit per-task gates.

## Runtime Flow

Serial mode executes this host-controlled loop:

1. Load and validate `harness.config.json`.
2. Load contracts, validate contract specs, and verify frozen contract hashes.
3. Load or create the series progress ledger.
4. Verify the target is inside a git repository when auto commit is enabled.
5. Verify the git worktree is clean except for allowed `.harness/series`
   progress state.
6. For each configured task in order:
   1. compute the task hash from task id, prompt, gate selector, and commit
      settings;
   2. if the ledger marks the same task id and hash as `completed`, skip it;
   3. if the ledger marks the task as `ready_to_commit`, finish the commit and
      then mark `completed`;
   4. otherwise mark the task `running`;
   5. create a fresh run environment for this task;
   6. execute the existing `runLoop` with this task's selected contracts;
   7. on `ready_for_mr`, record the gate-approved publication result as
      `ready_to_commit`;
   8. create the task commit if auto commit is enabled;
   9. mark the task `completed` with commit hash, run record path, and summary;
   10. continue to the next task.
7. Mark the series `completed` only after every task is completed.

Every task gets its own Agent sandbox. This prevents cross-task Claude context
contamination and makes each task start from the previous task's committed host
state. Retry attempts inside a task still reuse the task's Agent sandbox and
Claude resume session, which preserves feedback context for that task.

## Progress Ledger

The ledger is host-owned state. It is not part of the task commit.

Shape:

```json
{
  "schemaVersion": 1,
  "seriesId": "order-refactor",
  "status": "running",
  "configHash": "sha256...",
  "createdAt": "2026-06-17T00:00:00.000Z",
  "updatedAt": "2026-06-17T00:10:00.000Z",
  "tasks": [
    {
      "id": "extract-domain-model",
      "taskHash": "sha256...",
      "status": "completed",
      "commit": "abc1234",
      "runRecord": ".harness/runs/2026-06-17T00-05-00-000Z.json",
      "completedAt": "2026-06-17T00:05:00.000Z"
    }
  ]
}
```

Task statuses:

- `pending`: known from config but not started;
- `running`: task execution started and has not produced a committed result;
- `ready_to_commit`: gate passed and candidate files were published to the
  host, but the git commit has not been completed;
- `completed`: task has a recorded commit, or no commit was needed because the
  task produced no publishable file changes;
- `blocked`: task ended with `blocked`;
- `escalated`: task ended with `escalated`;
- `error`: task threw before a normal outcome.

Resume rules:

- `completed` with the same `taskHash` is skipped.
- `ready_to_commit` with the same `taskHash` attempts to finish the commit
  before running any agent.
- `running`, `blocked`, `escalated`, and `error` restart the same task from a
  fresh Agent sandbox.
- A completed task id with a different `taskHash` stops the series and asks the
  user to either restore the original task definition, choose a new task id, or
  reset the ledger. Harness must not guess whether a changed completed task
  should be skipped or rerun.
- Dirty git state that is not explained by `ready_to_commit` stops the series.

The runner writes the ledger atomically by writing a temporary file in the same
directory and renaming it into place.

## Automatic Git Commit

Automatic commits happen on the host after gate-approved publication.

Rules:

1. Auto commit requires a git repository.
2. Serial mode requires a clean worktree before each task starts, except for
   allowed `.harness/series` state.
3. The commit helper stages only the file paths reported by the publication
   result.
4. It never runs `git add -A .`.
5. It never stages `.harness/**` run records or series ledgers.
6. If the publication reports no changed files and `git diff --cached` is empty,
   Harness records the task as completed with no commit.
7. If `git commit` fails, Harness records `ready_to_commit` or `error` and
   stops the series.
8. The created commit hash is recorded in the ledger.

Commit message:

```text
harness: extract-domain-model

Harness-Task-Id: extract-domain-model
Harness-Series-Id: order-refactor
```

The trailer provides a secondary recovery hint, but the ledger remains the
primary progress source.

## Interruption And Recovery Cases

### Process stops before publish

The ledger task remains `running`. Resume starts the task again in a fresh
Agent sandbox.

### Process stops after publish but before commit marker

The worktree will be dirty, but the ledger will not explain that dirty state.
Harness stops before starting any Agent and reports the ambiguous paths. This is
intentional: automatic recovery cannot prove those files came only from the
published candidate.

### Process stops after `ready_to_commit`

Resume stages the recorded changed files, creates the commit, records the hash,
marks the task completed, and continues.

### Process stops after commit but before completed marker

Resume first checks the current `HEAD` trailer and changed-file state. If the
latest commit matches the task id and series id, Harness records the commit and
marks the task completed. If it cannot prove that, it stops for human review.

## `harness create` Git Initialization

`harness create <dir>` should ensure the target directory exists and then check
whether it is inside a git worktree.

If the target is outside any git worktree, Harness runs:

```bash
git init <target>
```

Then it writes the existing scaffold files. If the target is already inside a
worktree, no nested repository is created.

The create result should report whether git was initialized:

```text
git: initialized
```

or:

```text
git: existing repository
```

This does not create an initial commit. The user still controls the first
project commit.

## Implementation Shape

Likely files:

- `src/harness/scaffold.ts`: ensure target directory and optional `git init`;
  extend `CreateResult`.
- `src/harness/series.ts`: parse and validate task series config, select
  task-specific contracts, manage the progress ledger, and provide git helper
  functions.
- `src/harness/run.ts`: return or expose the successful publication result so
  the serial runner can stage only published paths.
- `src/cli.ts`: route no-position `run` into serial mode and keep explicit
  task mode unchanged.
- `src/index.ts`: export public series types only if they are useful outside
  the CLI.
- `test/scaffold.test.ts`: cover git initialization behavior.
- `test/harness-series.test.ts`: cover config parsing, gate selection, resume
  rules, and commit staging.
- `test/frozen-contract-callers.test.ts` or a new CLI test file: cover CLI
  compatibility for explicit task vs configured series.
- `docs/usage.md` and `README.md`: document serial mode and recovery rules.

## Testing Strategy

Use TDD for each behavior:

- config parser rejects duplicate task ids, invalid series ids, invalid commit
  templates, and unknown task fields;
- task gate selector merges defaults and task gate, expands stage selectors,
  fails on missing explicit contract ids, and fails on empty result;
- serial runner skips completed tasks with matching hashes;
- serial runner stops on completed task hash mismatch;
- `ready_to_commit` resumes by committing recorded changed files;
- commit helper stages only publication paths and never stages `.harness`;
- CLI explicit `harness run "task"` still uses single-task mode;
- CLI no-position `harness run` loads configured tasks;
- `createProject` initializes git outside a worktree and avoids nested git
  inside an existing worktree.

Full verification should run:

```bash
npm run check
```

Daytona integration remains explicit and should be used only when credentials
and local Daytona runtime are available:

```bash
npm run test:daytona
```

## Open Risks

- There is a small crash window after host publication and before the ledger can
  record `ready_to_commit`. The design handles this by stopping on ambiguous
  dirty state instead of guessing.
- If a target project tracks `.harness` files, the commit helper must still
  exclude `.harness/**` from task commits. Documentation should recommend
  ignoring runtime records.
- `runLoop` currently does not expose `PublicationResult` to callers. The
  implementation needs a narrow API change so serial mode can commit exactly
  the files that were gate-approved and published.

## Acceptance Criteria

1. `harness run "<task>"` remains backward compatible.
2. `harness run --driver claude` with configured `tasks` runs them in order.
3. Each task gets a fresh Agent sandbox and Claude session.
4. Retry attempts inside one task keep existing strong resume behavior.
5. Each task runs its configured gate selector.
6. Completed tasks are skipped on resume.
7. Interrupted `ready_to_commit` tasks can finish commit on resume.
8. Ambiguous dirty worktrees stop the series before any new Agent run.
9. Auto commits include only gate-published files and include task trailers.
10. `harness create .` initializes git when the target is not in a git repo.

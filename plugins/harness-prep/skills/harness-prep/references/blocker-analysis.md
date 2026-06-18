# Blocker Analysis

Use this when a run is stuck, blocked, escalated, repeatedly failing, or when the user asks what happened.

## Reliability Basis

Harness separates five surfaces:

1. Host control plane: contracts, config, run loop, run manifest.
2. Agent sandbox: mutating implementation work and Claude Code state.
3. Gate sandbox: fresh validation without model credentials.
4. Publication: exact evaluated candidate bytes written back to host.
5. Git history: optional, separate from publication except configured series auto commit.

Confusing these surfaces causes wrong diagnosis. Always reconstruct the timeline before proposing fixes.

## Evidence Capture

Run these first:

```bash
git status --short
harness status --dir contracts
harness review --dir contracts
harness runs list --json
harness runs show <runId> --json
```

If `harness runs` is unavailable or the CLI cannot start, fall back to raw files:

```bash
RUN_FILE="$(ls -t .harness/runs/*.json | head -1)"
node -e 'const r=require(process.argv[1]); console.log(JSON.stringify(r, null, 2))' "$RUN_FILE"
```

If the run used a series:

```bash
harness runs list --series-id <series-id> --json
find .harness/series -maxdepth 1 -type f -print
```

Then inspect the relevant series JSON.

## Timeline Reconstruction

From the RunStore record, build this table:

| Time/order | Surface | Evidence | Meaning |
|---|---|---|---|
| createdAt | host | run id, kind, task, driver | run created before Agent starts |
| selectedContracts | host | selected contract ids | what Gate was asked to judge |
| event: agent.* | Agent | sandbox id, attempt, exit code, session id | implementation attempt |
| event: gate.* | Gate | gate sandbox id, outcome | validation attempt |
| report/logs/summary/action | host | Gate report and runLoop logs | run loop decision |
| publication | host workspace | changed files, conflict, git status | candidate published or not |
| series parent/child | RunStore | parent `children[]`, child `parentRunId` | which task stopped |
| series ledger | git/history | task status, hash, commit | resume and auto commit state |

Use this event extraction:

```bash
harness runs show <runId> --json | node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(0,"utf8")); for (const e of r.events || []) console.log(`${e.at} ${e.event} ${JSON.stringify(e.data)}`)'
```

## Classify The Stop

### Contract/config `error`

Likely causes:

- contract missing required fields;
- command/tool not installed;
- HTTP service not started in Gate sandbox;
- unknown contract type;
- frozen contract hash mismatch;
- unsafe sandbox policy path;
- setup command failed.

Action: fix contract/config/setup before retrying Agent.
Use `sandbox-snapshots.md` to distinguish a real product failure from a missing sandbox tool. For example, `git`, `pnpm`, `yarn`, and `bun` are absent by default; `nvm` requires sourcing `/usr/local/nvm/nvm.sh`; Gate never has `claude`.

### Contract `fail`

Likely causes:

- implementation does not satisfy contract;
- gate feedback is too weak for agent to infer fix;
- wrong port/path/command expected by contract;
- intended behavior changed but contract was not updated.

Action: compare spec, contract, and gate diagnostic. If the contract is correct, rerun/fix implementation. If behavior is intentionally changed, create or resolve a `review` gate before editing the contract.

### `blocked`

Cause: at least one `review` contract produced `needs_review` and no verdict exists.

Action:

```bash
harness review --dir contracts
```

Ask the user to choose. Record only their decision.

### `escalated`

Likely causes:

- max attempts reached;
- repeated same failing check;
- publication conflict;
- context/budget stop;
- Agent command failure.

Action: inspect `action.reason`, failed contract ids, and latest Agent/Gate events. Do not increase attempts until you know why retry is not making progress.

### Run record `status: "error"`

Likely causes:

- missing `DAYTONA_API_KEY`;
- missing Anthropic env;
- invalid snapshot override;
- Daytona volume/mount failure;
- setup assumes host tools that are missing from Agent/Gate snapshots;
- proxy/no-proxy issue;
- setup exception before first attempt.

Action: inspect `errorReason`, `selectedContracts`, and `logs` if present; fix environment/config, then rerun. Do not treat this as implementation failure.

For no-task series runs, a malformed config or missing `tasks` can fail before a series RunStore record exists. Once a `kind: "series"` parent exists, inspect `children[]` and the stopped `kind: "series-task"` child before changing contracts or retry count.

## Daytona `.claude` Inspection

If Agent behavior is unclear, inspect persisted Claude artifacts through `observability-and-review.md`.

Use `.claude` to answer:

- Did Claude receive the expected task and gate feedback?
- Did retry resume the same `claudeSessionId`?
- Did Claude attempt to edit protected files?
- Did the model misunderstand because diagnostics were too vague?

Do not paste raw `.claude` content back to the user if it contains secrets or sensitive code. Summarize the relevant timeline.

## User Explanation Template

```text
The run stopped at <surface>: <host|agent|gate|publication|git>.
The concrete blocker is <evidence>.
This is <config error|implementation fail|human review|infrastructure error|publication conflict>.
Next action: <fix config|ask user decision|rerun agent|inspect Daytona artifacts|resolve git conflict>.
I am not changing protected contracts/config during Agent execution.
```

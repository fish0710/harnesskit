# Observability And Review

Use this when the user asks where a Harness task is, why it stopped, what Claude Code did, or how to resolve a human gate.

## Host Run Manifest

Harness writes v3 RunStore records on the host:

```text
.harness/runs/<runId>.json
```

Prefer the supported CLI query surface:

```bash
harness runs list --json
harness runs show <runId> --json
```

Use `runstore-observability.md` for record shape, single-run lookup, series parent/child lookup, and raw-file fallback commands.

Important fields in current v3 records:

- `kind`: `single`, `series`, or `series-task`.
- `status`: `running`, `completed`, or `error`.
- `outcome`: `ready_for_mr`, `blocked`, `escalated`, `completed`, or `error` when known.
- `selectedContracts`: contracts selected for this run or child task.
- `report`, `logs`, `publication`, `summary`, `action`, `errorReason`: final diagnosis context.
- `attempts[].agentSandboxId`: Agent sandbox used by Claude attempt.
- `attempts[].gateSandboxIds`: fresh Gate sandboxes created for validation.
- `attempts[].claudeSessionId` and `resumedFromSessionId`: strong resume proof.
- `observability.volumeName`: default `harness-claude-observability`.
- `observability.mountPath`: default `/harness-observability`.
- `observability.runRoot`: durable run root recorded by Harness.

Treat `.harness/runs` as sensitive operational data. It can include task prompts and raw event data.

For configured series, inspect the parent `kind: "series"` record and the stopped `kind: "series-task"` child. Also inspect `.harness/series/<series-id>.json` for resume/commit state.

## Human Review Gates

If `harness run` exits 2 or reports `blocked`, list review items:

```bash
harness review --dir contracts
```

Read the contract and the referenced spec before recommending a decision. Explain to the user:

- what question is being decided;
- what evidence exists;
- what each option means;
- whether choosing pass changes the intended product contract.

Record only the user's decision:

```bash
harness review --resolve <contractId> --option <optionId> --by "<name>" --reason "<reason>"
```

Then rerun the relevant check or continue the run.

## Daytona Claude Artifacts

`harness run --driver claude` persists Claude Code artifacts by default when Daytona volume support is available.

Default environment:

```bash
export HARNESS_DAYTONA_OBSERVABILITY=1
export HARNESS_DAYTONA_OBSERVABILITY_VOLUME="harness-claude-observability"
export HARNESS_DAYTONA_OBSERVABILITY_MOUNT="/harness-observability"
```

The Agent sandbox sees only its run subpath mounted at:

```text
/harness-observability
```

Claude writes native state to sandbox-local HOME while the command is running:

```text
/home/daytona/.claude
```

Before the Agent sandbox is cleaned up, Harness copies that directory into the
mounted Daytona volume:

```text
/harness-observability/.claude
```

This is a copy into the Daytona observability volume, not a copy to the Harness
host filesystem. RunStore records the paths needed to find the volume later; it
does not embed `.claude` JSONL content in `.harness/runs`.

The raw Claude CLI `stream-json` stdout is written independently to:

```text
/harness-observability/attempt-<n>/claude-stream.jsonl
```

Do not mount the Daytona volume directly at `/home/daytona/.claude`: real
Daytona probes showed that direct HOME mount can leave native
`projects/<session>.jsonl` with only queue/user/attachment startup events. Let
Claude write to sandbox-local HOME, then use the Harness copy at
`/harness-observability/.claude`.

Gate sandboxes do not receive this volume and do not receive model credentials.

## Inspecting A Deleted Sandbox's `.claude`

If the original Agent sandbox still exists, inspect sandbox-local
`/home/daytona/.claude` and the mounted `/harness-observability` through the
Daytona sandbox file API. If it was deleted, create a temporary inspection
sandbox with the same volume and subpath.

Use the RunStore record for `runId`, `observability.volumeName`, and `observability.mountPath`. The volume subpath is:

```text
runs/<runId>
```

Daytona SDK sketch:

```js
import { Daytona } from "@daytona/sdk";
import fs from "node:fs";

const runFile = process.argv[2];
const record = JSON.parse(fs.readFileSync(runFile, "utf8"));
const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL || "http://localhost:3000/api"
});

const volume = await daytona.volume.get(record.observability.volumeName, true);
const sandbox = await daytona.create({
  language: "typescript",
  envVars: {},
  ephemeral: true,
  volumes: [{
    volumeId: volume.id,
    mountPath: record.observability.mountPath,
    subpath: `runs/${record.runId}`
  }]
});

try {
  const root = record.observability.mountPath;
  console.log(await sandbox.fs.listFiles(root));
  console.log(await sandbox.fs.listFiles(`${root}/.claude`));
  console.log(await sandbox.fs.listFiles(`${root}/attempt-1`));
} finally {
  await daytona.delete(sandbox);
}
```

Path rule: use absolute mounted paths with the Daytona file API, such as `/harness-observability` and `/harness-observability/.claude`. Relative paths like `harness-observability` can produce misleading 404s.

Expected inspection paths after the Agent sandbox is deleted:

```text
/harness-observability/.claude/projects/<project-key>/<session-id>.jsonl
/harness-observability/attempt-<n>/claude-stream.jsonl
```

Use `attempts[].claudeSessionId` to select the native JSONL. The copied native
JSONL should contain assistant messages plus `tool_use` and `tool_result`
content. The stream JSONL is an independent complete transcript source and is
also useful when checking final `result`, model usage, and command output.

## Status Explanation Template

When reporting status to the user, separate:

- Harness host state: run manifest, outcome, attempts.
- Agent state: Claude session id, Agent sandbox id, `.claude` artifacts.
- Gate state: contract results, gate sandbox ids, blocked review items.
- Publication state: whether gate-approved candidate bytes were published to the host workspace.
- Git state: whether any commit was created. Single-task runs stop at `ready_for_mr`; configured serial runs can auto-commit if `autoCommit.enabled` is true.

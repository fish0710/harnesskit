# Serial Task Series Example

This example runs a configured task series with the local `command` driver. It
is intentionally small so the full serial path can be exercised without Daytona
or Claude credentials.

The command agent reads `HARNESS_TASK` and writes one file per task:

- `src/domain-model.ts`
- `src/order-service.ts`

The example config includes `scripts` in `sandbox.candidateRoots` so the local
command agent is uploaded into the Agent sandbox. The actual task outputs still
live under `src`.

Each task has its own gate contract. Run it from a copy of this directory:

```bash
git init
git config user.email harness@example.test
git config user.name "Harness Example"
git add .
git commit -m "example baseline"

node /path/to/harness/dist/src/cli.js run \
  --driver command \
  --agent-cmd "sh scripts/agent.sh" \
  --dir contracts
```

Expected result:

- both configured tasks run in order;
- `.harness/series/order-refactor-example.json` is written with `completed`
  task entries;
- `src/domain-model.ts` and `src/order-service.ts` are created.

`autoCommit.enabled` is set to `false` here because the local command driver
edits the host example directly and does not have a sandbox publication step.
Daytona/Claude serial runs can leave `autoCommit` enabled.

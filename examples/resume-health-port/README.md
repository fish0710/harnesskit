# Resume Health Port Example

This is a minimal Daytona Claude resume verification fixture.

The candidate-visible task document asks Claude to create
`examples/resume-health-port/src/server.js` on port `3321`, but the protected
HTTP contract checks `http://127.0.0.1:3320/health`. The server file is omitted
from the baseline on purpose, so the first agent attempt must generate it.

Expected loop:

1. Claude works in one persistent Daytona agent sandbox.
2. The first candidate exposes `/health` on `3321`.
3. The gate sandbox starts the candidate server and checks port `3320`.
4. The gate fails and Harness feeds the HTTP diagnostic back to Claude.
5. The next Claude attempt must resume the captured Claude session in the same
   agent sandbox and change the server to port `3320`.
6. A fresh gate sandbox validates the corrected candidate.

Run from the repository worktree root:

```bash
npm run build
node dist/src/cli.js run "Read examples/resume-health-port/TASK.md and implement it exactly. Do not edit examples/resume-health-port/contracts or examples/resume-health-port/harness.config.json." \
  --driver claude \
  --dir examples/resume-health-port/contracts \
  --config examples/resume-health-port/harness.config.json
```

After the run, inspect the host manifest:

```bash
RUN_FILE="$(ls -t .harness/runs/*.json | head -1)"
node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({runId:r.runId,status:r.status,attempts:r.attempts}, null, 2))' "$RUN_FILE"
```

The manifest should show the same `claudeSessionId` being resumed on the later
attempt.

The agent sandbox mounts the Daytona volume subpath `runs/<runId>` at:

```text
/harness-observability
```

Inside that mounted run root, Claude state is stable across attempts:

```text
/harness-observability/.claude
```

To inspect the persisted Claude session after sandbox cleanup, mount or inspect
the Daytona volume `harness-claude-observability` at subpath
`runs/<runId>` and browse `.claude`. The session files should show the original
conversation continuing after the gate failure feedback instead of a fresh
conversation being started.

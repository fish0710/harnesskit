# Agent And Gate Environment

Use this before writing `harness.config.json` or explaining how the implementation agent will work. Read `sandbox-snapshots.md` before choosing setup commands or assuming a tool exists in Agent/Gate sandboxes.

## Reliability Basis

Harness reads candidate roots, read-only context paths, protected paths, setup commands, and byte limits from `harness.config.json`. Mutating `claude` and `command` agents run in Daytona isolation; each gate attempt runs in a fresh agent-free Gate sandbox. A passing gate publishes only the exact candidate bytes evaluated by that gate.

Therefore the environment must be explicit before execution. Hidden assumptions become gate `error`, repeated retries, or unsafe mutation scope.

## Environment Inventory

Create or update the spec with this table. Do not start `harness run` while any required row is unknown.

| Area | Required answer | Where it goes |
|---|---|---|
| Target repo root | Absolute or current working directory | command cwd |
| Harness CLI | `harness` or `node dist/src/cli.js` | run commands |
| Package manager | `npm`, `pnpm`, `yarn`, `pip`, etc. | `agentSetup`, `gateSetup` |
| Install command | e.g. `npm ci` | `sandbox.agentSetup` |
| Build/typecheck command | e.g. `npm run build` | `command` contract |
| Unit/integration command | e.g. `npm test` | `command` contract |
| Service start command | e.g. `npm run dev -- --port 3000` | `sandbox.gateSetup` |
| Loopback ports | Gate sandbox ports, not host ports | `http` contracts |
| Mutable paths | implementation-owned files only | `sandbox.candidateRoots` |
| Read-only context paths | task docs, repo map, setup manifests the agent needs but must not change | `sandbox.readOnlyPaths` |
| Protected paths | contracts, config, CI, trusted gates, Harness state | `sandbox.protectedPaths` |
| Secrets needed by agent | names only, never values in repo | shell env / secret manager |
| Secrets needed by gate | usually none; justify if needed | host environment |
| Daytona API | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL` | shell env |
| Claude model env | Anthropic env vars | shell env |
| Snapshots | optional `HARNESS_DAYTONA_AGENT_SNAPSHOT`, `HARNESS_DAYTONA_GATE_SNAPSHOT` | shell env |
| Proxy/no-proxy | remote Daytona may need proxy cleared; local needs `proxy.localhost` bypass | shell env |
| Local host dependencies | WeChat DevTools, database, browser, etc. | host-local contract notes |

## Sandbox Policy Rules

- Start narrow: only include paths the implementation agent must change.
- Keep these protected by default: `contracts`, `.harness`, `harness.config.json`, `.github/workflows`, `CODEOWNERS`, and trusted gate runners such as `test/gates`.
- Put these in `readOnlyPaths` by default when they exist: `AGENTS.md`,
  `docs/specs`, and `docs/plans`.
- Treat setup inputs as read-only environment assets when Agent or Gate setup
  needs them but the task must not change them: `.nvmrc`, root `package.json`,
  package-manager lockfiles, `tsconfig.json`, `babel.config.js`, and
  `postcss.config.js`.
- Do not put root dependency files in `candidateRoots` just because setup runs
  `npm ci`. If root setup is legacy baseline, put those files in
  `readOnlyPaths` so Agent and Gate install from the same baseline manifest.
- If the task intentionally changes dependencies, include the package manifest
  and lockfile together in `candidateRoots`, explain the risk to the user, and
  make Agent/Gate setup install from that same project root.
- If every candidate root is covered by protection or read-only paths, stop and revise the policy.
- Put dependency installation in `agentSetup` when the agent needs tools to edit or test.
- Put service startup or gate-only preparation in `gateSetup`.
- The default Daytona snapshots already include Node.js 22.14.0, npm/npx 10.9.2, Python 3.11, curl, make, gcc, and bash. They do not include `git`, `pnpm`, `yarn`, or `bun`.
- `nvm` is not a binary. If a setup command uses it, source `/usr/local/nvm/nvm.sh` first; otherwise prefer plain `npm ci`.
- Gate snapshots intentionally do not include `claude`; never put `claude` in `gateSetup` or contracts.
- Do not put long-lived secrets in either setup command. Setup commands are repo-visible configuration.
- If an HTTP contract targets `127.0.0.1`, remember that in Daytona Gate mode it means the Gate sandbox. Start the service in `gateSetup`.

## Claude/Daytona Preflight

Before `--driver claude`, verify the user has supplied environment values outside the repo:

```bash
env | grep -E '^(DAYTONA_API_KEY|DAYTONA_API_URL|ANTHROPIC_|HARNESS_DAYTONA_)' | sed 's/=.*/=<set>/'
```

Required for Claude runs:

```text
DAYTONA_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
```

`ANTHROPIC_MODEL` and `ANTHROPIC_REASONING_MODEL` are optional when defaults are set.

For local Daytona, preserve no-proxy coverage for:

```text
localhost,127.0.0.1,.localhost,proxy.localhost
```

For remote Daytona with a closed local proxy, clear stale proxy vars before running.

## Agent Workspace Paths

Do not tell users to look for `/workspace/candidate` in an interactive Daytona
shell. Harness uses `/workspace/candidate` as an internal logical remote root,
but the Daytona SDK receives it as the relative SDK path `workspace/candidate`.
In the Agent sandbox shell this resolves under the `daytona` user's home:

```text
/home/daytona/workspace/candidate
```

Use these names precisely:

| Surface | Path |
|---|---|
| Harness logical remote root | `/workspace/candidate` |
| Daytona SDK file/process path | `workspace/candidate` |
| Interactive Agent shell cwd | `/home/daytona/workspace/candidate` |
| Claude native state | `/home/daytona/.claude` |
| Claude observability mount | `/harness-observability` |

## User-Facing Explanation

Before asking for run confirmation, say:

```text
The agent may edit: <candidateRoots>.
The agent may read but not publish: <readOnlyPaths>.
Harness hides and protects: <protectedPaths>.
Agent setup will run: <agentSetup>.
Gate setup will run: <gateSetup>.
Secrets stay in shell/env and are not written to the repository.
```

If any line is not true, fix the config first.

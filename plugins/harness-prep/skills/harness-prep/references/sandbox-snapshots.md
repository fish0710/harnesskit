# Daytona Sandbox Snapshots

Use this before writing `agentSetup`, `gateSetup`, command/http contracts, or
snapshot guidance. Do not assume the user's host tools exist in Agent or Gate
sandboxes.

## Verified Snapshot Contract

Default Harness runtime snapshots:

| Role | Default snapshot | Purpose |
|---|---|---|
| Agent | `harness-agent-claude-latest` | Implementation sandbox for `--driver claude` |
| Gate | `harness-gate-runtime-latest` | Fresh validation sandbox without Claude/model credentials |

The checked-in source pins:

```text
Node.js 22.14.0
npm 10.9.2
npx 10.9.2
Claude Code 2.1.145
Agent source: harness-agent-claude-2.1.145-r2
Gate source: harness-gate-runtime-node-22.14.0-r2
```

Refresh or verify latest snapshots from the Harness source checkout:

```bash
npm run snapshot:agent
npm run snapshot:gate
npm run snapshot:runtime
```

Those scripts create short-lived Daytona sandboxes, run toolchain preflight, and
delete the sandboxes. They require `DAYTONA_API_KEY` and optional
`DAYTONA_API_URL`; do not print the key.

## Observed Runtime Inventory

Live probe on 2026-06-18 against both default latest snapshots showed:

| Capability | Agent latest | Gate latest | Setup impact |
|---|---|---|---|
| OS/user | Debian 13, user `daytona`, home `/home/daytona` | same | Avoid host-specific paths. |
| Shell | `$SHELL=/bin/sh`, `/usr/bin/bash` exists | same | Use `bash -lc` only when needed. |
| Node | `/usr/local/bin/node` v22.14.0 | same; Node 14.21.3/npm 6.14.18 also preinstalled under nvm | Default Node gates can run without install; old `.nvmrc` projects can `nvm use` the preinstalled Node 14. |
| npm/npx | `/usr/local/bin/npm`, `/usr/local/bin/npx` 10.9.2 | same | Prefer `npm ci`/`npm test` for JS projects. |
| nvm | `NVM_DIR=/usr/local/nvm`, `nvm.sh` exists, no `nvm` binary | same | Source nvm before `nvm use`. |
| corepack | direct `corepack --version` works; `bash -lc corepack` did not | same | Prefer direct `corepack` or explicit path. |
| pnpm/yarn/bun | missing | missing | Install/enable explicitly if required. |
| Python | Python 3.11.14, pip 24.0 | same | Python gates can use `python3`/`pip3`. |
| git | missing | missing | Do not put `git` commands in setup/gates unless installed. |
| curl/make/gcc | present | present | Native builds may work, but verify project deps. |
| Claude | `/usr/local/bin/claude` 2.1.145 | missing | Gate must not run Claude commands. |
| Writable paths | `/home/daytona`, `/tmp`; `/usr/local` not writable | same | Install project deps in workspace/home, not `/usr/local`. |
| sudo | passwordless in probe | passwordless in probe | Prefer non-sudo setup; use sudo only if justified. |
| Network | raw snapshot could reach `https://example.com` | raw snapshot could reach it | Harness may block Gate network after setup. |

Locale warnings such as `setlocale: LC_ALL: cannot change locale
(en_US.UTF-8)` may appear before command output. Contracts should rely on exit
codes or structured evidence markers, not exact first-line stdout.

## nvm And Shell Rules

nvm is a shell function loaded from `/usr/local/nvm/nvm.sh`, not an executable.
This fails:

```json
"agentSetup": ["nvm use 22.14.0 && npm ci"]
```

Use this if a project really needs `nvm`:

```json
"agentSetup": [
  "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 22.14.0 && npm ci'"
]
```

Because Node 22.14.0 is already active in the default snapshots, prefer a plain
`npm ci` unless the project explicitly requires a different Node version.

The default Gate snapshot keeps Node 22.14.0 active at `/usr/local/bin/node`.
It also preinstalls Node 14.21.3 with npm 6.14.18 for older projects. A Vue 2
or other old `.nvmrc` project can install dependencies in `gateSetup` with:

```json
"gateSetup": [
  "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 14.21.3 && npm ci'"
]
```

In Gate, `/usr/local/nvm` is not writable by the `daytona` user. `nvm use` can
select versions already present in the snapshot, but do not rely on `nvm install`
in Gate contract commands or ordinary `gateSetup`; missing versions try to write
`/usr/local/nvm/.cache` and can fail before contracts run.

If a project requires another Node version, prefer creating a dedicated Gate
snapshot with that version preinstalled. A user-writable
`NVM_DIR=$HOME/.nvm` can work for explicit one-off setup, but the snapshot path
is the recommended default for repeatable Harness runs.

## Gate Network Timing

Harness assembles the evaluated candidate in a fresh Gate sandbox, runs
`sandbox.gateSetup`, then applies the Gate network policy before executing
remote contracts.

- If any selected remote `http` contract targets loopback (`127.0.0.1`,
  `localhost`, `::1`, or `*.localhost`), Harness leaves Gate network open so the
  sandbox-local service can be checked.
- Otherwise Harness blocks Gate network before remote contracts run.
- Therefore install dependencies and start services in `gateSetup`.
- Do not write command contracts that fetch from the internet during Gate run;
  fetch or install in `gateSetup`, or vendor/cache the dependency.
- Do not open Gate contract-stage network just to install dependencies. Only
  loopback HTTP contract checks of sandbox-local services need the network block
  left open after setup.

`127.0.0.1` in an HTTP contract means the Gate sandbox, not the host.

## Contract And Config Consequences

- Use `npm ci`, `npm test`, `npm run build`, `python3`, `pip3`, or explicit
  project-local scripts in contracts.
- Do not use `git` in Agent/Gate setup or contracts unless setup installs it.
- Do not use `claude` in Gate setup/contracts; Gate is intentionally agent-free.
- If using `pnpm`, `yarn`, or `bun`, add an explicit setup step and validate it
  before `harness run`.
- Keep setup commands deterministic and non-secret; environment variables should
  name secrets but never store values in repo files.

## Live Probe Checklist

When the current snapshot state matters, verify instead of guessing:

```bash
source ~/.zshrc >/dev/null 2>&1 || true
npm run snapshot:runtime
```

For deeper investigation, create short-lived Daytona sandboxes from the Agent and
Gate snapshots, run read-only probes, record sandbox ids in notes, and delete
them. Redact `DAYTONA_API_KEY`, Anthropic tokens, and proxy credentials.

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

## Scaffolded Runtime Context

`harness create` writes `docs/reference/harness-runtime.md` and default config
should expose `docs/reference` through `sandbox.readOnlyPaths`. Agents can read
that file before changing dependencies, build scripts, `agentSetup`,
`gateSetup`, or remote command/http contracts, but they must not publish edits
to it during implementation tasks.

Keep that project-local reference aligned with these Gate facts:

- Gate has no Claude, model credentials, or Agent state.
- Gate has Node.js 22.14.0 and npm/npx 10.9.2 by default.
- `git`, `pnpm`, `yarn`, and `bun` are not installed by default.
- `nvm` requires `source /usr/local/nvm/nvm.sh` before `nvm use`.
- Gate network is blocked after `gateSetup` for ordinary remote contracts.
- 127.0.0.1 means the Gate sandbox, not the developer host.

## Enhanced Agent Latest Snapshot

Live probe on 2026-06-24 rebuilt and verified `harness-agent-claude-latest`
from this enhanced snapshot source:

```text
harness-agent-claude-toolchain-20260624-071637-r5
```

The default Claude Agent snapshot now includes the enhanced toolchain. Pin the
source snapshot only when diagnosing latest drift:

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT=harness-agent-claude-toolchain-20260624-071637-r5
```

The latest snapshot keeps the pinned Claude toolchain (`node` 22.14.0, `npm`/`npx`
10.9.2, Claude Code 2.1.145) and adds common implementation tools: `git`,
`git-lfs`, `jq`, `wget`, `unzip`, `zip`, `rsync`, `ssh`/`scp`, Docker CLI and
Compose, `pnpm`, `yarn`, `bun`, Go, Rust/Cargo, Java/Javac, Maven, Gradle,
PHP, Ruby/Gem, SQLite, PostgreSQL/MySQL/Redis clients, `zsh`, `vim`, and
`nano`.

It also fixes common shell and language-environment friction:

- `en_US.UTF-8` locale is generated.
- `/etc/profile.d/harness-toolchain.sh` sources nvm, selects Node 22.14.0,
  prepends `/home/daytona/.local/bin`, and de-duplicates `PATH`.
- `.profile`, `.bashrc`, `.zshrc`, `.zprofile`, and `.zshenv` load that profile
  script, so bash and zsh shells both expose `nvm`.
- `python` and `python3` resolve to Python 3.11.14 from `/usr/local/bin`.
- `python3-venv`, `pipx`, `uv`, and `uvx` are available, but no virtual
  environment is activated by default.
- Corepack is enabled. Project `packageManager` fields should pin package
  manager versions; otherwise Corepack may select its current Known Good
  default.

Known boundary: Docker CLI is present, but a Docker daemon/socket is not
guaranteed in ordinary Daytona Agent sandboxes. Treat `docker build` or Compose
workflows as requiring a daemon-capable sandbox or project-specific setup.

## Observed Runtime Inventory

Live probes on 2026-06-24 against the rebuilt Agent latest and earlier Gate
latest showed:

| Capability | Agent latest | Gate latest | Setup impact |
|---|---|---|---|
| OS/user | Debian 13, user `daytona`, home `/home/daytona` | same | Avoid host-specific paths. |
| Shell | `$SHELL=/bin/sh`; `/usr/bin/bash` and `/usr/bin/zsh`; bash/zsh profile load the Harness toolchain profile | `$SHELL=/bin/sh`, `/usr/bin/bash` exists | Use `bash -lc` only when needed; Agent interactive shells expose `nvm`. |
| Node | `/usr/local/bin/node` v22.14.0 | same; Node 14.21.3/npm 6.14.18 also preinstalled under nvm | Default Node gates can run without install; old `.nvmrc` projects can `nvm use` the preinstalled Node 14. |
| npm/npx | `/usr/local/bin/npm`, `/usr/local/bin/npx` 10.9.2 | same | Prefer `npm ci`/`npm test` for JS projects. |
| nvm | `nvm` available in bash/zsh after profile load; current Node v22.14.0 | `NVM_DIR=/usr/local/nvm`, `nvm.sh` exists, no `nvm` binary | Gate setup must still source nvm before `nvm use`. |
| corepack | enabled, `corepack --version` 0.31.0 | direct `corepack --version` works; `bash -lc corepack` did not in earlier probe | Use `packageManager` in `package.json` to pin pnpm/yarn versions. |
| pnpm/yarn/bun | present; pnpm follows Corepack Known Good default without project pin | missing | Gate setup must install/enable these if Gate contracts need them. |
| Python | Python 3.11.14, pip 24.0, `python3-venv`, `pipx`, `uv`, `uvx`; no venv active by default | Python 3.11.14, pip 24.0 | Python gates can use `python3`/`pip3`; Agent projects should use `.venv` or `uv`. |
| git | present, including `git-lfs` | missing | Do not put `git` in Gate setup/contracts unless Gate installs it. |
| curl/make/gcc | present | present | Native builds may work, but verify project deps. |
| Claude | `/usr/local/bin/claude` 2.1.145 | missing | Gate must not run Claude commands. |
| Docker | Docker CLI and Compose present; daemon/socket not guaranteed | missing | `docker build` or Compose workflows need daemon-capable setup. |
| Writable paths | `/home/daytona`, `/tmp`; `/usr/local` not writable without sudo | same | Install project deps in workspace/home, not `/usr/local`. |
| sudo | passwordless in probe | passwordless in probe | Prefer non-sudo setup; use sudo only if justified. |
| Network | raw snapshot could reach `https://example.com` | raw snapshot could reach it | Harness may block Gate network after setup. |

The rebuilt Agent latest generates `en_US.UTF-8`. Gate snapshots may still emit
locale warnings such as `setlocale: LC_ALL: cannot change locale
(en_US.UTF-8)`. Contracts should rely on exit codes or structured evidence
markers, not exact first-line stdout.

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

For enhanced Agent snapshots that load `/etc/profile.d/harness-toolchain.sh`,
plain `bash -lc` or `zsh -lc` should expose `nvm` and a de-duplicated `PATH`.
Still prefer project-local commands (`npm ci`, `pnpm install`,
`corepack pnpm install`) over global package installation.

If a Node project uses `pnpm` or `yarn`, prefer a `packageManager` field in
`package.json` so Corepack selects the intended version. Without that field,
Corepack may use its current Known Good default instead of the version a human
expects from memory.

## Python Environment Rules

Do not activate a global virtual environment in the Agent snapshot. The base
environment should stay neutral so each project can create its own `.venv` or
use `uv`.

- Prefer `uv sync`, `uv run`, or `python -m venv .venv` inside the project.
- Use `pipx` for Python CLI tools such as `ruff`, `httpie`, or `pre-commit`
  when the tool should not become a project dependency.
- Do not rely on globally installed Python packages for project behavior. The
  Daytona SDK or other global packages can exist in site-packages, but project
  commands should use `.venv`, `uv`, or explicit project dependency manifests.
- If a project requires Python versions other than the snapshot default
  Python 3.11.14, prefer `uv python install` in `agentSetup` or a dedicated
  snapshot. Do not assume `pyenv` or Conda exists.

## Dependency Manifest Boundaries

Keep Agent and Gate dependency setup pointed at the same intended manifests.
`agentSetup` prepares the mutating Agent sandbox; `gateSetup` prepares a fresh
Gate sandbox from host baseline plus candidate bytes. If the Agent can publish a
setup manifest, Gate setup will consume that candidate manifest before contracts
run.

Default to treating root setup files as protected environment inputs:
`.nvmrc`, `package.json`, package-manager lockfiles, `tsconfig.json`,
`babel.config.js`, and `postcss.config.js`. Put them in `candidateRoots` only
when the current task intentionally changes root dependencies or build
configuration, and include manifest plus lockfile together.

For isolated apps or subprojects, scope setup and contracts to that directory
instead of running root installs by accident:

```json
"agentSetup": ["bash -lc 'cd vue3-app && npm ci'"],
"gateSetup": ["bash -lc 'cd vue3-app && npm ci'"]
```

If Gate setup fails before any contract runs, inspect whether the Agent was
allowed to mutate the files used by that setup command. Fix `candidateRoots` and
`protectedPaths`, then resume the original series id rather than starting a new
ledger.

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
- Do not use `git` in Gate setup or contracts unless Gate setup installs it.
- Do not use `claude` in Gate setup/contracts; Gate is intentionally agent-free.
- If Gate contracts use `pnpm`, `yarn`, or `bun`, add an explicit Gate setup
  step and validate it before `harness run`.
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

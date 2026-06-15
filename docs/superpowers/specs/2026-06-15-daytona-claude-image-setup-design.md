# Daytona Claude Image And Setup Execution Design

Date: 2026-06-15

## Objective

Remove Claude Code installation from the Harness run path and eliminate the
PTY-based setup failure that leaves `harness run` waiting in an interactive
shell.

The implementation must produce a complete Daytona-compatible agent image,
register a reusable Daytona Snapshot, and run project setup through
non-interactive command execution. Agent and gate trust boundaries remain
separate.

## Confirmed Root Cause

The current Agent sandbox is created from Daytona's default TypeScript image.
Harness uploads the candidate workspace and runs `agentSetup` through a PTY.

In the local Daytona PTY, the interactive login shell does not expose the NVM
Node installation on `PATH`. The configured command:

```sh
npm install
```

therefore produces:

```text
bash: exec: npm: not found
```

Because Bash remains interactive after the failed `exec`, the PTY does not
exit. Harness buffers the output and waits for PTY completion, making the run
appear stuck at `agent.create.start`.

The unit test used a fake PTY that recorded input and immediately returned a
synthetic exit code. The explicit Daytona integration test did not configure
`agentSetup`, so neither test covered this failure.

## Selected Architecture

### Agent Image

Create a reproducible Docker image for Claude-backed Agent sandboxes.

Initial immutable tool versions:

```text
Base image: daytonaio/sandbox:0.5.0-slim
Node.js: 22.14.0
Claude Code: 2.1.145
```

The image must contain:

- Node.js `22.14.0` and its bundled npm/npx from the Daytona base image's
  versioned NVM installation;
- `@anthropic-ai/claude-code@2.1.145`;
- `node`, `npm`, `npx`, and `claude` available from `/usr/local/bin`;
- Git, POSIX shell, and the normal Daytona toolbox/runtime requirements
  inherited from the supported Daytona base image.

The build must not contain:

- Anthropic credentials;
- Daytona API credentials;
- model names or supplier URLs;
- project source code;
- gate contracts or signing material.

The initial artifact names are:

```text
Docker image: harness-daytona-claude:2.1.145-r1
Daytona Snapshot: harness-agent-claude-2.1.145-r1
```

Image revisions are explicit. Updating Claude Code or changing image contents
requires a new image tag and Snapshot name. Existing Snapshots remain usable
for rollback until deliberately removed.

The Docker build runs its installation steps as root, links the locked
versioned Node toolchain into `/usr/local/bin`, installs the locked Claude Code
package, then restores the normal `daytona` runtime user. Runtime behavior must
not depend on `.bashrc`, `.profile`, NVM shell initialization, or an
interactive login shell.

### Snapshot Build And Registration

Provide a repository command:

```sh
npm run snapshot:agent
```

The command must:

1. build the complete local Docker image;
2. verify `node`, `npm`, `npx`, and `claude`;
3. verify that `node --version` reports `v22.14.0` and `claude --version`
   reports `2.1.145`;
4. create the named Daytona Snapshot when it does not exist;
5. when the name already exists, verify that it matches the expected immutable
   artifact instead of overwriting it;
6. activate the Snapshot when required and wait until it is usable;
7. create a temporary sandbox from the Snapshot;
8. repeat the toolchain preflight inside the temporary sandbox;
9. delete the temporary sandbox;
10. print the exact Snapshot name to configure.

The build script must fail closed. It must not report success if image
verification, Snapshot creation, activation, sandbox creation, or sandbox
preflight fails.

Snapshot names are immutable release identifiers. If an existing Snapshot does
not match the expected image release, the build fails and requires a new
revision such as `r2`; it must not delete or overwrite a Snapshot that could be
serving active runs.

### Agent And Gate Separation

Harness selects the Agent Snapshot through:

```text
HARNESS_DAYTONA_AGENT_SNAPSHOT=harness-agent-claude-2.1.145-r1
```

Claude Agent sandboxes must use this Snapshot.

Gate sandboxes must not use the Agent Snapshot. They continue to use a
separately configured gate Snapshot or Daytona's default Snapshot. Gate
sandboxes receive no Claude installation and no model credentials.

The Snapshot value is selected by the host process and is never writable by
the Agent.

## Harness Runtime Changes

### Sandbox Creation

Extend the internal sandbox creation request with an optional Snapshot.

The Daytona provider maps the host-selected Snapshot to
`daytona.create({ snapshot })`. Labels, ephemeral behavior, and network
settings remain unchanged.

For a Claude Agent run:

1. require `HARNESS_DAYTONA_AGENT_SNAPSHOT`;
2. create the Agent sandbox from that Snapshot;
3. upload Agent-visible workspace files;
4. run the toolchain preflight;
5. run `agentSetup`;
6. launch Claude.

Harness must not silently fall back to Daytona's default Snapshot when the
Claude Agent Snapshot variable is absent.

### Toolchain Preflight

Before project setup, execute a non-interactive command that verifies:

- `node` exists;
- `npm` exists;
- `npx` exists;
- `claude` exists;
- Node.js reports exactly `22.14.0`;
- Claude Code reports exactly `2.1.145`.

Missing tools or a version mismatch abort the run before the Agent receives
the task. Error output must include the expected and observed versions but no
credentials.

The preflight validates the runtime artifact. It is not a repair mechanism and
must never install or upgrade tools.

### Runtime Claude Installation

Remove the current runtime command:

```sh
npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code
```

Harness launches the image-provided Claude executable from its stable absolute
path:

```text
/usr/local/bin/claude
```

Model credentials and model supplier settings remain an allowlisted runtime
environment passed only to the Claude command.

### Setup Commands

`agentSetup` and `gateSetup` are non-interactive lifecycle commands. Execute
each command through `SandboxHandle.execute`, not `runPty`.

Each command:

- runs independently in the candidate workspace;
- has a default ten-minute timeout;
- captures stdout, stderr, exit code, and duration;
- stops the phase immediately on failure;
- returns a bounded output tail in the failure message.

Setup commands continue to be project-controlled configuration. They run only
inside their respective sandbox and cannot alter host-controlled contracts or
classification logic.

### PTY Usage

PTY remains reserved for interactive Agent drivers such as Claude Code.

Harness wraps PTY commands so command lookup or startup failures always exit
the shell with a nonzero status. The PTY implementation must:

- forward bounded output to Harness observations while running;
- retain output for the final driver result;
- kill the PTY on timeout or cancellation;
- include the bounded output tail in timeout and startup errors;
- disconnect in all terminal states.

The implementation must not depend on interactive shell profile files to
discover Node, npm, or Claude.

## Observability

Emit host-controlled phase observations:

```text
agent.create.start/end/fail
agent.upload.start/end/fail
agent.preflight.start/end/fail
agent.setup.start/end/fail
agent.command.start/end/fail
gate.create.start/end/fail
gate.setup.start/end/fail
gate.verify.start/end/fail
```

Each terminal event includes elapsed time. Setup events may include the command
index but must not echo environment values. PTY output observations are
bounded and must pass through existing credential-redaction rules.

## Configuration

Required for Claude-backed Daytona runs:

```text
DAYTONA_API_URL
DAYTONA_API_KEY
HARNESS_DAYTONA_AGENT_SNAPSHOT
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_MODEL
ANTHROPIC_REASONING_MODEL
```

The Snapshot name is not a secret. Credentials remain environment-only and
must not be copied into Docker build arguments, image layers, Snapshot
metadata, logs, or configuration files.

## Tests

### Unit And Adapter Tests

Add tests that prove:

- Agent creation uses the configured Agent Snapshot;
- Gate creation never inherits the Agent Snapshot;
- a missing Agent Snapshot fails before sandbox creation;
- runtime Claude installation is no longer invoked;
- preflight accepts Node.js `22.14.0` and Claude Code `2.1.145`;
- preflight rejects missing tools and version mismatch;
- setup commands use `execute`, not `runPty`;
- setup failure stops subsequent commands;
- PTY command startup failure terminates instead of returning to a prompt;
- PTY timeout reports the captured output tail;
- observations cover every lifecycle phase without credentials.

Mocks may verify adapter mapping, but behavioral tests must not claim real
Daytona compatibility from fake PTY behavior.

### Real Daytona Integration

Extend `npm run test:daytona` to require the configured Agent Snapshot and run
with:

```json
{
  "agentSetup": ["npm install"]
}
```

The test must:

1. create an Agent sandbox from the complete Claude Snapshot;
2. pass the exact toolchain preflight;
3. execute `npm install` through non-interactive setup;
4. run Claude and modify the candidate;
5. collect candidate bytes on the host;
6. create an Agent-free Gate sandbox;
7. run the contract and classify the evidence on the host;
8. publish the accepted bytes;
9. delete temporary Agent and Gate sandboxes.

The test fails if the Agent sandbox does not use the configured Snapshot or if
the Gate sandbox uses it.

## Verification

Required verification sequence:

```sh
npm run check
npm run snapshot:agent
HARNESS_DAYTONA_AGENT_SNAPSHOT=harness-agent-claude-2.1.145-r1 \
  npm run test:daytona
```

After integration verification, rerun the original `harness run` scenario with
`agentSetup: ["npm install"]`. The run must progress through explicit upload,
preflight, setup, and Agent command phases without runtime Claude installation
or a silent PTY wait.

## Documentation And Operations

Update the local Daytona runbook with:

- prerequisites for building the image;
- exact image and Snapshot commands;
- version upgrade procedure;
- rollback procedure;
- Snapshot environment configuration;
- preflight failure diagnosis;
- confirmation that Gate sandboxes do not contain Claude;
- cleanup commands for old images and Snapshots.

The generated complete image and active Snapshot are implementation
deliverables, not documentation-only examples.

## Out Of Scope

- automatically upgrading Claude Code;
- sharing model credentials through the image;
- using the Agent Snapshot for Gate execution;
- selecting images or Snapshots from Agent-controlled task text;
- removing project-specific `agentSetup` or `gateSetup`;
- changing the host-owned gate classification protocol.

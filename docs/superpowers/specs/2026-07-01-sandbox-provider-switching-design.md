# Sandbox Provider Switching And Docker Runtime Design

## Current Request

Harness currently has a useful internal sandbox seam, but the real runtime is
still Daytona-centered. `SandboxProvider` and `SandboxHandle` exist, yet the CLI
creates Daytona providers directly, runtime selection uses Daytona snapshot
environment variables, run environment names mention Daytona, and the runtime
toolchain is documented as Daytona snapshots.

The requested direction is to make Harness depend on a provider-neutral sandbox
capability model. Harness should declare what it needs, and each built-in
provider should implement those capabilities according to its own runtime
model. The first non-Daytona provider should be Docker, and Docker should cover
the full first-class path: Claude agent, command agent, Gate preflight, Gate
execution, retained resume, and observability.

## Goals

- Add built-in sandbox provider switching with `daytona` and `docker`.
- Keep Daytona as the compatibility default unless configuration explicitly
  selects another provider.
- Make the run loop, Gate preflight, candidate collection, Gate execution, and
  publication provider-neutral.
- Model provider capabilities explicitly and fail before agent startup when a
  selected provider cannot satisfy the requested mode.
- Support Docker for:
  - `harness preflight gate`;
  - `harness run --driver command`;
  - `harness run --driver claude`;
  - fresh Gate sandboxes for each remote Gate attempt;
  - retained agent sandbox resume;
  - Claude stream and `.claude` observability artifacts.
- Preserve exact-byte host publication from the candidate snapshot that passed
  Gate.

## Non-Goals

- Do not add third-party provider plugin registration.
- Do not implement Kubernetes in this phase.
- Do not silently fall back to host execution when a sandbox provider cannot be
  created.
- Do not bind-mount the mutable candidate workspace as the primary transfer
  path. Docker should still use Harness upload, collect, verify, and publish
  semantics for candidate bytes.
- Do not weaken the Agent/Gate trust boundary.
- Do not require Docker to imitate Daytona snapshots, volumes, toolbox proxy
  URLs, or `/home/daytona` paths.

## Must Preserve

- Agent and Gate sandboxes remain separate.
- Gate sandboxes never receive model credentials or Claude tooling.
- Gate sandboxes are fresh per remote Gate attempt.
- Agent sandboxes may be persistent across attempts for feedback and Claude
  resume.
- The host remains the trusted control plane for policy loading, evidence
  classification, candidate collection, Gate result interpretation, and
  publication.
- Protected and read-only paths remain host-owned.
- A passing Gate means the exact collected candidate is publishable, not that
  the sandbox itself is trusted.

## Recommended Approach

Introduce a provider-neutral sandbox layer, then migrate Daytona and add Docker
as built-in providers behind that layer.

The main shape is:

```ts
export type SandboxProviderKind = "daytona" | "docker";

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  readonly capabilities: SandboxCapabilities;
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  attach?(sandboxId: string): Promise<SandboxHandle>;
}

export interface SandboxCapabilities {
  persistentAgent: boolean;
  attach: boolean;
  pty: boolean;
  volumeMounts: boolean;
  bindMounts: boolean;
  dynamicNetworkBlock: boolean;
  createTimeNetworkBlock: boolean;
  fileModePreservation: boolean;
}
```

Harness should not ask "is this Daytona?" in the run loop. It should ask "does
the selected provider support the capabilities required by this run?"

### Runtime References

Replace the provider-specific `snapshot` field at the Harness orchestration
boundary with a typed runtime reference:

```ts
export type SandboxRuntimeRef =
  | { kind: "daytonaSnapshot"; name: string }
  | { kind: "dockerImage"; image: string };

export interface SandboxRuntimeProfile {
  runtime: SandboxRuntimeRef;
  workspaceRoot: string;
  interactiveWorkspaceRoot?: string;
  agentHome?: string;
}

export interface SandboxCreateRequest {
  role: "agent" | "gate";
  runtime: SandboxRuntimeRef;
  envVars: Record<string, string>;
  lifecycle: "persistent" | "ephemeral";
  mounts?: SandboxMount[];
  network?: SandboxNetworkRequest;
}
```

Daytona maps `daytonaSnapshot` to the SDK `snapshot` parameter. Docker maps
`dockerImage` to `docker create` or `docker run` image selection.

The provider-neutral run environment receives resolved Agent and Gate runtime
profiles. `workspaceRoot` is the logical path used by Harness orchestration and
GateCore execution. A provider may expose a different human-facing interactive
path for diagnostics, but orchestration should not depend on it.

## Alternatives Considered

### Minimal Adapter Only

Keep the current `SandboxProvider` mostly unchanged and add a Docker
implementation that treats `snapshot` as an image.

This has the smallest code change, but it preserves the wrong abstraction.
Docker and future providers would inherit Daytona vocabulary, and provider
selection would remain scattered through CLI and toolchain code.

### Provider-Neutral Layer With Built-In Providers

Add provider-neutral types, provider selection, runtime profiles, and
capability validation. Migrate Daytona into the new model and add Docker.

This is the recommended option. It is large enough to remove the current
Daytona coupling, but scoped enough to avoid a plugin architecture.

### Full Sandbox Plugin System

Make providers externally registered plugins.

This is too broad for the current need. The target is built-in provider
switching, not public extension points.

## Configuration

Add provider selection under `sandbox`:

```json
{
  "sandbox": {
    "provider": "docker",
    "runtimes": {
      "agent": { "image": "harness-agent-claude:2.1.145-r2" },
      "gate": { "image": "harness-gate-runtime:node-22.14.0-r2" }
    }
  }
}
```

Daytona remains supported:

```json
{
  "sandbox": {
    "provider": "daytona",
    "runtimes": {
      "agent": { "snapshot": "harness-agent-claude-latest" },
      "gate": { "snapshot": "harness-gate-runtime-latest" }
    }
  }
}
```

Compatibility rules:

- If `sandbox.provider` is absent, use `daytona`.
- If Daytona runtime fields are absent, keep using the existing defaults:
  `harness-agent-claude-latest` and `harness-gate-runtime-latest`.
- Existing `HARNESS_DAYTONA_AGENT_SNAPSHOT` and
  `HARNESS_DAYTONA_GATE_SNAPSHOT` remain Daytona-specific overrides.
- Add provider-neutral overrides only where they are unambiguous:
  `HARNESS_SANDBOX_PROVIDER=docker` can select Docker for local experiments.
  Runtime references should come from config unless a later phase adds
  provider-specific env overrides.
- If `provider` is `docker` and runtimes are absent, use documented local image
  defaults: `harness-agent-claude:2.1.145-r2` and
  `harness-gate-runtime:node-22.14.0-r2`. If those images are missing, fail
  before creating an Agent sandbox with a Docker runtime readiness error.

## Provider Selection

Add a built-in provider factory layer:

```ts
export interface SandboxProviderFactoryInput {
  provider: SandboxProviderKind;
  environment: Record<string, string | undefined>;
  root: string;
  config: HarnessConfig;
}

export function createSandboxProvider(
  input: SandboxProviderFactoryInput,
): SandboxProvider;
```

The CLI should call this once and pass the selected provider into both Gate
preflight and the run environment. This avoids creating one provider for
preflight and another unrelated provider for the run.

`RunStore` records should include the provider kind and runtime references:

```ts
interface RunRecordSandbox {
  provider: "daytona" | "docker";
  agentRuntime?: SandboxRuntimeRef;
  gateRuntime: SandboxRuntimeRef;
  agentSandboxId?: string;
}
```

Retained resume must require the current provider to match the recorded
provider. A Docker retained container must not be resumed through Daytona, and a
Daytona retained sandbox must not be resumed through Docker.

## Provider-Neutral Run Environment

Rename the orchestration surface:

- `createDaytonaRunEnvironment` becomes `createSandboxRunEnvironment`.
- `DaytonaRunEnvironmentOptions` becomes `SandboxRunEnvironmentOptions`.
- `createDaytonaExecutionTarget` becomes `createSandboxExecutionTarget`.

Keep deprecated exports as compatibility aliases during the migration where
reasonable, but implementation should live behind provider-neutral names.

The run environment remains responsible for:

1. Capturing the host baseline.
2. Creating or attaching the persistent Agent sandbox.
3. Uploading agent-visible files.
4. Running agent setup.
5. Running Claude or command agent attempts.
6. Collecting candidate bytes from the Agent sandbox.
7. Creating a fresh Gate sandbox.
8. Uploading baseline and candidate bytes into Gate.
9. Running `gateSetup`.
10. Applying provider-supported network isolation.
11. Running GateCore against the Gate sandbox execution target.
12. Verifying protected files.
13. Publishing exact approved candidate bytes on pass.
14. Cleaning up sandboxes according to lifecycle and retention policy.

## Capability Validation

Before creating an Agent sandbox, validate the requested mode:

| Request | Required capabilities |
| --- | --- |
| Gate preflight | `create`, file upload/read/list, command execute, delete |
| `--driver command` | persistent agent, file upload/read/list, PTY or command execute |
| `--driver claude` | persistent agent, command execute, file read, Claude runtime profile |
| retained resume | `attach` |
| observability mount | `volumeMounts` or `bindMounts` |
| post-setup Gate network block | `dynamicNetworkBlock` |
| create-time isolated Gate | `createTimeNetworkBlock` |

`create`, `delete`, file transfer, file listing, file reading, and command
execution are baseline provider methods. Capability flags cover behavior that is
not guaranteed across all built-in providers.

If a provider lacks a required capability, Harness should return a readiness
error before any mutating agent starts.

Network behavior should be explicit:

- Daytona can keep the current dynamic block model.
- Docker should implement dynamic Gate network isolation by creating Gate
  containers on a Harness-managed Docker network, running `gateSetup`, then
  disconnecting external networks or moving the container to a blocked internal
  network before contract execution. Loopback inside the container must keep
  working.
- If Docker network operations are unavailable or fail, Harness must treat the
  Gate attempt as a readiness error instead of running contracts with broader
  network access.
- When a contract needs loopback HTTP inside Gate, Harness must not apply a
  network rule that prevents the Gate container from reaching its own loopback
  service.

## Docker Provider

### Container Lifecycle

Docker provider creates containers with labels:

```text
harness.role=agent|gate
harness.provider=docker
harness.runId=<runId>
harness.lifecycle=persistent|ephemeral
```

Agent containers:

- are created as persistent containers;
- remain alive across attempts;
- are deleted on successful publication;
- may be retained on failure when `sandbox.retainOnFailure` is true;
- can be resumed by container id if the run record provider is `docker`.

Gate containers:

- are created fresh for preflight and each remote Gate attempt;
- receive no model credentials;
- are deleted after the attempt unless retained for diagnostics.

### Workspace Transfer

Docker provider should not use the host worktree as the mutable container
workspace. Instead:

- create the configured workspace root inside the container;
- upload files by archive copy, for example `docker cp` or an equivalent tar
  stream;
- preserve executable bits;
- list and read files from inside the container when collecting candidates;
- verify protected files by size, mode, and hash as the provider-neutral
  `SandboxHandle` requires.

This keeps the existing host-owned candidate collection and exact-byte publish
model intact.

### Process Execution

The provider should implement:

- `execute(command, cwd, env, timeoutMs)` through `docker exec`;
- `runPty(command, cwd, env, timeoutMs, signal)` through `docker exec -it` or a
  controlled pseudo-terminal wrapper;
- process timeout and signal handling that returns bounded stdout/stderr;
- safe command environment injection without leaking model credentials to Gate.

Claude does not require a host-side TTY if the existing command wrapper can run
through non-interactive `execute`. PTY support is still needed for command
agents that expect interactive behavior and for parity with Daytona.

### Docker Images

The first Docker images should match the existing runtime contract:

- Agent image:
  - Node.js 22.14.0;
  - npm/npx;
  - Claude Code 2.1.145;
  - `/usr/bin/bash`;
  - no project source baked into the image.
- Gate image:
  - Node.js 22.14.0;
  - npm/npx;
  - python3;
  - curl;
  - `/usr/bin/bash`;
  - legacy Node/npm support equivalent to the current Gate snapshot where
    practical;
  - no Claude binary and no model credentials.

Images can initially live beside the existing Daytona Dockerfiles, but the file
names should not imply Daytona ownership. A later cleanup can move shared image
content under provider-neutral paths.

### Observability

Docker should support the same logical observability paths used by Harness:

```text
HARNESS_OBSERVABILITY_RUN_ROOT=/harness-observability
HARNESS_OBSERVABILITY_ATTEMPT_ROOT=/harness-observability/attempt-<n>
HARNESS_CLAUDE_STREAM_PATH=/harness-observability/attempt-<n>/claude-stream.jsonl
HARNESS_CLAUDE_HOME_SNAPSHOT_DIR=/harness-observability/.claude
```

Implementation may use a Docker named volume or a host bind mount under the
Harness run store. This mount is for observability artifacts only. It is not
the primary mutable candidate workspace.

### Resume

Docker retained resume uses the recorded container id:

1. Load the run record.
2. Confirm `provider === "docker"`.
3. Confirm the current selected provider is Docker.
4. Attach to the retained container by id.
5. Run Claude toolchain preflight inside the container.
6. Recover or validate the Claude session id using the same stream semantics as
   the existing Daytona path.
7. Run Gate-first validation before resuming agent work.

If the container is missing, stopped in an unrecoverable state, or runtime
metadata does not match, resume fails closed.

## Daytona Migration

Daytona should become a provider implementation, not the orchestration owner.

The Daytona adapter remains responsible for:

- reading `DAYTONA_API_KEY` and `DAYTONA_API_URL`;
- mapping `daytonaSnapshot` to SDK `snapshot`;
- resolving Daytona volumes;
- rewriting toolbox proxy URLs;
- creating, attaching, deleting, and executing inside Daytona sandboxes.

Provider-neutral code should no longer import Daytona-specific functions except
through the built-in provider factory.

## CLI And Documentation

Update CLI help and docs to say:

- `scaffold` is local dry run;
- `command` runs in the selected sandbox provider;
- `claude` runs in the selected sandbox provider;
- default provider is Daytona for compatibility;
- Docker requires a local Docker daemon and configured images.

The preflight command description should become provider-neutral:

```text
harness preflight gate ... # rehearses Gate setup/contracts in the selected Gate sandbox
```

Keep Daytona-specific docs, but move them under provider-specific sections.
Add a Docker runtime section with image build, provider selection, resume, and
cleanup guidance.

## Testing Strategy

Add provider contract tests that every built-in provider can run against fake
or local implementations:

- create agent and gate sandboxes with the expected lifecycle;
- upload, list, read, remove, and verify files;
- preserve executable bits;
- execute commands with cwd and env;
- reject path escapes;
- run PTY commands or report unsupported capability;
- apply network isolation according to declared capability;
- delete ephemeral sandboxes;
- attach retained sandboxes when supported.

Add Docker-focused tests:

- Docker request mapping creates containers with expected labels and image;
- candidate workspace is copied, not host-mounted as mutable source;
- command and Claude agent paths use persistent containers;
- Gate creates fresh containers per attempt;
- Gate containers do not receive model credentials;
- retained resume rejects provider mismatch;
- observability artifacts are written to the configured mount;
- cleanup removes ephemeral Gate containers and successful Agent containers.

Existing Daytona tests should remain, but test names should distinguish
provider-neutral behavior from Daytona adapter behavior.

## Rollout Plan

1. Add provider-neutral types and provider factory.
2. Move Daytona adapter behind the factory while keeping existing behavior.
3. Rename run environment and execution target to provider-neutral names.
4. Extend config loading for `sandbox.provider` and `sandbox.runtimes`.
5. Update run records with provider/runtime metadata.
6. Implement Docker provider file/process/container lifecycle.
7. Add Docker images or shared image build targets.
8. Wire Docker provider into CLI and preflight.
9. Add docs and examples.
10. Keep compatibility exports and Daytona env overrides for at least one
    release cycle.

## Open Constraints

- Docker dynamic network blocking must be proven on supported host platforms.
  If it is unreliable, the first implementation must fail closed for contracts
  that require post-setup network isolation.
- Docker PTY behavior can differ across platforms. The first implementation
  should prefer non-interactive `execute` for Claude and reserve PTY for custom
  command agents that need it.
- Docker cleanup should be conservative. A failed cleanup must be visible in
  the run record and preflight report.

# Daytona Agent Sandbox And External Gate Design

## Status

Approved on 2026-06-11.

## Goal

Run every mutating Harness agent command inside a persistent Daytona sandbox,
evaluate each candidate in a fresh agent-free Daytona sandbox, and keep all
contracts, verdicts, aggregation, retry, escalation, and publication decisions
under host control.

## Current State

`harness run --driver claude` currently calls the Claude Agent SDK in the host
process with the target repository as `cwd`. The agent has `Bash`, `Edit`, and
`Write`, so it can reach the same files used by `GateCore`. After the agent
returns, `runLoop` executes `GateCore` against that same host directory.

The local Daytona exploration in `test/daytona-claude.ts` proves that Daytona
0.186.0 can create a TypeScript sandbox, install Claude Code under the sandbox
user's home directory, inject model credentials into a PTY, and run Claude Code
successfully. That exploration is not connected to the production driver or
gate loop.

`contractHash` also needs hardening. Its current top-level JSON replacer does
not include nested contract fields, so changing a nested expectation may not
invalidate a frozen contract.

## Threat Model

The design must prevent an agent from affecting a decision by:

- changing contracts, verdicts, gate selection, invariant implementations,
  trusted tests, CI gate scripts, or the Harness gate runtime;
- forging Git state, a candidate patch, a successful test transcript, or a
  final `GateReport`;
- carrying processes, caches, filesystem state, or credentials from the agent
  environment into a gate attempt;
- escaping the candidate workspace through absolute paths, `..`, symbolic
  links, special files, or oversized candidate output;
- racing publication so that bytes different from those evaluated are written
  to the host workspace.

The first version does not claim that source code cannot leave through model
requests. The agent must access an approved model endpoint, and its model token
is necessarily available to the agent runtime. Use a scoped, short-lived token.
Gate, Daytona control-plane, signing, and human-verdict credentials must never
be placed in either candidate code or the gate sandbox.

## Chosen Architecture

Use a host snapshot, a host-computed candidate file set, and a fresh gate
sandbox for every attempt.

```text
Host baseline -> persistent agent sandbox -> host candidate collector
                                             |
                                             v
Host contracts -> Host GateCore -> fresh gate sandbox
                       |
                       v
              pass / retry / blocked / escalate
```

A full clone or fork of the agent sandbox is not a valid gate environment. It
would preserve files and hidden state already controlled by the agent.

## Components

### Host Orchestrator

The host orchestrator owns the run state machine. It captures the baseline,
loads and selects contracts, loads verdicts, validates frozen contracts,
creates both sandbox types, invokes `GateCore`, constructs feedback, enforces
budgets, and publishes an accepted candidate.

Only the host can produce the effective `pass`, `retry`, `blocked`, or
`escalate` decision.

### Host Workspace Snapshot

The run starts by enumerating Git tracked and non-ignored untracked files from
the current working tree. This includes current uncommitted work. The first
version requires a Git worktree so ignored dependency directories, build
outputs, local Harness state, and secrets are not copied accidentally.

For each included regular file the snapshot stores:

- normalized repository-relative path;
- executable bit;
- byte length;
- SHA-256;
- exact content source on the host.

Symbolic links and special files inside candidate roots are rejected in the
first version. The host `.git` directory is never uploaded.

### Persistent Agent Sandbox

One agent sandbox exists for the complete loop. It receives only agent-visible
baseline files, the task, and later host-generated diagnostics. It does not
receive contracts, verdicts, gate selection, invariant modules, trusted tests,
or the Harness gate implementation.

The `claude` driver installs and runs Claude Code using the validated local
Daytona configuration. The `command` driver uses the same sandbox boundary.
The scaffold driver remains a no-op and does not require Daytona.

The agent sandbox's stdout, exit status, Git metadata, manifests, hashes, and
patches are untrusted observations. They never become a gate result.

### Candidate Collector

After the agent command ends, the host recursively enumerates the agent
workspace through the Daytona filesystem API and downloads regular files under
configured candidate roots. It normalizes and validates every path before
using it.

The collector compares downloaded bytes with the host baseline. It produces
host-owned add, modify, delete, and mode-change operations. It does not use
`git diff` from the agent sandbox because the agent can rewrite `.git` and
`HEAD`.

Collection enforces limits for file count, individual file size, and aggregate
bytes. Any unknown file mode, symlink, special file, path escape, transfer
failure, or limit violation is an `error`.

### Fresh Gate Sandbox

Every attempt creates a new gate sandbox. It receives:

1. the trusted host baseline;
2. the host-validated candidate operations;
3. configured trusted test assets, restored from the host after any dependency
   setup step.

It receives no model token and contains no agent process. It is deleted after
the attempt unless an explicit diagnostic retention option is enabled.

The gate sandbox is an execution target, not the decision maker.

### External Gate Control

`GateCore`, contract objects, verdicts, plugin registration, status
classification, aggregation, and escalation stay in the host process.

`RunContext` gains an execution target. Command-like plugins send a trusted
command request to that target and receive raw evidence:

- host-issued execution ID;
- process exit code;
- stdout and stderr;
- duration;
- spawn, timeout, or protocol error.

The HTTP plugin similarly receives status, headers, body, and transport errors
from an execution target request made inside the gate sandbox when required.
Review and aggregation remain entirely local. Invariant definitions remain
host-owned.

Candidate code can make a checked process succeed or fail, which is the
behavior under evaluation. It cannot return a `CheckResult` or `GateReport`.
Missing evidence, an execution ID mismatch, malformed evidence, timeout, or
sandbox failure is `error`, never `pass`.

Contracts should invoke explicit trusted test entrypoints. A mutable candidate
script such as `npm test` is not by itself a trusted judge because the agent
can change the script definition. Trusted tests should live under a protected
directory and be invoked explicitly by contract arguments.

## Run Lifecycle

1. Validate Daytona configuration and load sandbox policy.
2. Load, validate, freeze-check, and select contracts on the host.
3. Load verdicts and invariant implementations on the host.
4. Capture the immutable host baseline and protected-asset hashes.
5. Create and initialize one agent sandbox.
6. Execute the agent command and wait for completion.
7. Collect candidate bytes through the Daytona filesystem API.
8. Validate candidate paths, types, sizes, and protected-asset rules.
9. Create a fresh gate sandbox.
10. Assemble trusted baseline plus candidate operations.
11. Run optional trusted dependency setup.
12. Restore protected test assets from the host and verify their hashes.
13. Run selected gates through the remote execution target.
14. Delete the gate sandbox.
15. On `fail` or `error`, pass sanitized host diagnostics to the existing agent
    sandbox and repeat.
16. On `blocked`, stop for human review.
17. On loop-budget exhaustion, escalate.
18. On `pass`, verify that host destination paths still match the original
    baseline, then atomically apply the exact evaluated operations.
19. Clean up the agent sandbox unless diagnostic retention was requested.

The exact candidate captured for a gate attempt is retained on the host until
that attempt is resolved. Publication never re-reads live agent files.

## Configuration

Sandbox policy extends `harness.config.json` without changing existing selector
fields:

```json
{
  "baseline": ["smoke.boot"],
  "rules": [],
  "sandbox": {
    "candidateRoots": ["src", "lib", "test/generated"],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates"
    ],
    "agentSetup": [],
    "gateSetup": [],
    "limits": {
      "maxFiles": 10000,
      "maxFileBytes": 10485760,
      "maxTotalBytes": 209715200
    },
    "retainOnFailure": false
  }
}
```

Paths are repository-relative directory or file prefixes after strict
normalization. `candidateRoots` is an allowlist. A project created by Harness
will receive an explicit default policy; an existing project without policy
uses a conservative built-in policy and prints the effective values.

Protected assets are not uploaded to the agent sandbox. A protected directory
may be uploaded to the gate sandbox when a trusted test requires it.

## CLI Behavior

- `--driver claude` and `--driver command` use Daytona isolation by default.
- There is no silent fallback to host execution when Daytona is unavailable.
- A missing API key, unreachable API, candidate collection error, or sandbox
  creation failure stops the run with a nonzero result.
- Any future local-agent escape hatch must be explicitly named unsafe and must
  print a warning. It is outside the initial implementation.
- `harness check` and `harness gate` retain their current local behavior; this
  design changes the agent-driven `run` and `fix` loop.

## Publication

Publication applies only the exact add, modify, delete, and executable-mode
operations that passed the gate.

Before writing, the publisher verifies that each affected host path still has
the baseline state captured when the run began. A concurrent host edit causes a
conflict and no candidate bytes are written. New or modified files are written
through a temporary sibling followed by rename. Deletes occur only after all
preconditions pass.

Protected paths are checked again at publication even though they were checked
during collection.

## Frozen Contract Hardening

Contract hashing uses recursive canonical JSON:

- object keys sorted at every depth;
- array order preserved;
- freeze metadata excluded only at the contract root;
- nested expectation, trigger, examples, and decision fields included.

A test must demonstrate that changing `expect.status` invalidates an existing
frozen hash.

## Error Handling

The following are fail-closed `error` conditions:

- Daytona configuration or connectivity failure;
- sandbox create, setup, execute, transfer, or delete failure;
- malformed or mismatched execution evidence;
- candidate path, type, or size violation;
- protected asset modification;
- trusted asset hash mismatch;
- gate timeout or process launch failure;
- publication conflict.

Cleanup failures are reported. They do not turn a failed run into a pass.
Diagnostics sent back to the agent are bounded and remove credentials and host
absolute paths.

## Testing

All Daytona interactions are behind injected interfaces. Unit tests use fake
sandboxes and do not need a running Daytona service.

Required coverage:

- nested frozen-contract changes invalidate the hash;
- Claude and command runs create an agent sandbox by default;
- multiple attempts reuse one agent sandbox;
- every gate attempt creates a fresh sandbox;
- gate sandboxes receive no model credentials or agent installation;
- agent Git state and claimed patches are ignored;
- protected modifications, symlinks, path escapes, and size violations fail;
- `GateCore` remains on the host and classifies remote raw evidence;
- gate failure and infrastructure errors do not publish;
- an accepted candidate publishes exact evaluated bytes;
- publication detects concurrent host changes;
- loop budgets and human review preserve existing behavior;
- cleanup occurs on pass, failure, exception, and escalation.

A separate opt-in integration test may exercise the local Daytona API using
environment credentials. It must never run as part of the normal unit test
suite.

## Acceptance Criteria

- The agent process cannot read or modify host gate assets.
- No agent-controlled value is accepted as a gate verdict.
- A fresh agent-free sandbox evaluates every attempt.
- Failed attempts continue in the original agent sandbox using sanitized host
  feedback.
- Only a host-classified passing candidate is written to the original working
  tree.
- Existing `fail`, `error`, `needs_review`, retry, and escalation semantics are
  preserved.
- Normal tests run without Daytona; an explicit integration test proves the
  real local flow.

## Non-Goals

- General container orchestration beyond Daytona.
- A guarantee that model-visible source cannot leave the model endpoint.
- Reusing an agent sandbox as a trusted gate environment.
- Trusting candidate-provided test scripts without protected external tests.
- Automatically merging, pushing, or approving the resulting changes.

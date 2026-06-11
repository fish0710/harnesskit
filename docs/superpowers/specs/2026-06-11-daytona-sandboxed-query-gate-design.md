# Daytona Sandboxed Query and External Gate Design

Date: 2026-06-11
Status: Approved design

## 1. Objective

Change `harness run` so that real agent work runs in a Daytona sandbox by
default, while gate selection, interpretation, aggregation, retry, and
escalation remain outside every agent-accessible environment.

The agent produces an untrusted candidate workspace. The host builds a fresh
gate sandbox from trusted assets plus host-validated candidate files. Only
evidence collected from that gate sandbox and interpreted by the host
`GateCore` may affect the final decision.

Candidate changes are written back to the host workspace only after the
external gate passes.

## 2. Security Properties

The implementation must enforce these properties:

1. The agent cannot read or modify contracts, verdicts, gate configuration,
   trusted tests, gate implementation, or gate credentials.
2. Agent logs, Git metadata, patches, hashes, exit summaries, and claims of
   success are untrusted and cannot directly produce a passing result.
3. Candidate files are collected through the Daytona filesystem API and
   compared by the host against an immutable baseline.
4. Every gate attempt runs in a newly created sandbox with no agent runtime,
   model credential, Daytona credential, or Langfuse credential.
5. Gate checks are selected and interpreted by trusted host code. A candidate
   program can provide only raw observable evidence.
6. Missing evidence, malformed evidence, timeouts, transfer failures, and
   sandbox failures become `error`, never `pass`.
7. Failed or blocked candidates do not modify the host workspace.

This boundary prevents the agent from changing its judge. It does not claim to
prevent source code from being sent to the configured model service because
the agent requires model access. Network egress restriction is a later
hardening phase.

## 3. Threat Model

The design addresses attempts to:

- modify frozen contracts or nested expectation fields;
- forge `.harness/verdicts.json`;
- alter `harness.config.json`, contract selection, or invariant properties;
- weaken CI, `CODEOWNERS`, gate scripts, or trusted tests;
- replace the Harness gate implementation or its dependencies;
- manipulate `.git`, `HEAD`, or an agent-generated patch;
- add symlinks or special files that escape the candidate workspace;
- forge a successful test message or gate report;
- leave hidden state for the next gate attempt;
- cause infrastructure failures to be treated as successful validation.

## 4. Architecture

### 4.1 Host Orchestrator

The host orchestrator owns:

- the immutable baseline manifest;
- trusted contracts, verdicts, gate configuration, and trusted tests;
- creation and cleanup of Daytona sandboxes;
- candidate collection and validation;
- gate selection and `GateCore` aggregation;
- retry budgets and escalation;
- final application of a passing candidate.

It is the only component allowed to decide `pass`, `retry`, `blocked`, or
`escalate`.

### 4.2 Agent Sandbox

One agent sandbox is created for a complete run and reused across retry rounds.
It contains only the project files that policy permits the agent to see and
modify. It receives:

- the task;
- candidate project files;
- the previous round's sanitized gate diagnostics;
- only the credentials required to run the selected agent.

It does not receive contracts, verdicts, trusted tests, gate configuration,
gate implementation, host Git metadata, or gate credentials.

Both `claude` and `command` production drivers use this sandbox by default.
The existing `scaffold` driver remains a local dry run because it executes no
agent query and produces no candidate.

### 4.3 Candidate Collector

The host builds a baseline manifest before creating any sandbox. Each entry
contains the relative path, entry type, mode, size, and SHA-256 digest.

After an agent command finishes, the collector recursively lists the agent
workspace with the Daytona filesystem API and downloads candidate files. It
does not use sandbox Git state or an agent-produced archive or patch.

The collector:

- normalizes every relative path;
- rejects absolute paths and paths containing `..`;
- accepts only regular files and directories;
- rejects symlinks and special filesystem entries;
- enforces candidate root and protected path policy;
- enforces per-file and total transfer limits;
- computes all hashes on the host;
- records additions, modifications, and deletions relative to the baseline.

The output is a host-owned `CandidateChangeSet`, not an agent-owned patch.

### 4.4 Gate Sandbox

A new gate sandbox is created for every validation round. It receives:

1. the trusted host baseline;
2. the validated candidate changes;
3. trusted contracts and gate assets needed for the selected checks;
4. only non-agent runtime variables explicitly required by those checks.

It contains no Claude Code installation, Agent SDK process, model credentials,
Daytona API key, or Langfuse credentials. It is destroyed after the round.

### 4.5 External Gate Control

`GateCore`, contract selection, status interpretation, aggregation, retry, and
escalation execute on the host.

Sandbox-backed gate plugins use a host-owned execution interface. For each
operation the host creates a random execution ID and sends a fixed command,
working directory, environment allowlist, and timeout to the gate sandbox. The
sandbox returns raw evidence:

- execution ID;
- exit code;
- stdout;
- stderr;
- duration;
- spawn or transport error.

The host verifies the execution ID and applies the trusted contract to that
evidence. The gate sandbox never returns an authoritative `GateReport`.

## 5. Runtime Flow

1. Parse and validate the run configuration on the host.
2. Load and freeze the selected trusted contracts and verdicts in host memory.
3. Build the immutable baseline manifest and protected asset snapshot.
4. Create one agent sandbox and upload only the agent-visible workspace.
5. Execute the configured agent command and wait for completion.
6. Collect a candidate change set through Daytona filesystem APIs.
7. Reject policy violations as a failed round with actionable diagnostics.
8. Create a fresh gate sandbox.
9. Upload the trusted baseline and apply the validated candidate change set.
10. Inject trusted gate assets that were absent from the agent sandbox.
11. Run selected checks through the host-owned sandbox execution interface.
12. Interpret and aggregate raw evidence on the host.
13. Destroy the gate sandbox in `finally`.
14. On `fail` or `error`, sanitize diagnostics and send them to the original
    agent sandbox for the next attempt.
15. On `needs_review`, stop automatic execution and escalate to a human.
16. On budget or repeated-failure exhaustion, escalate with the last trusted
    report.
17. On `pass`, revalidate every affected host path against the original
    baseline. Any concurrent host change stops application and escalates a
    workspace conflict.
18. Transactionally apply the validated candidate change set with staging,
    backups, and a recovery journal.
19. Clean up the agent sandbox in `finally`, unless an explicit debug retention
    option is enabled.

No failed round writes candidate content to the host workspace.

## 6. Candidate Policy

The policy is allowlist based. A path must be under a configured candidate root
and must not match a protected path.

Initial defaults:

```json
{
  "sandbox": {
    "provider": "daytona",
    "candidateRoots": ["src", "lib", "app", "packages", "test/generated"],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github",
      "ci",
      "CODEOWNERS"
    ],
    "trustedTestPaths": ["test/gates"],
    "maxFileBytes": 10485760,
    "maxCandidateBytes": 104857600,
    "retainOnFailure": false
  }
}
```

Projects must be able to override candidate roots and add protected or trusted
test paths. Overrides may broaden candidate roots but cannot remove mandatory
Harness control paths from protection.

Existing trusted tests cannot be modified or deleted. New tests are accepted
only under candidate roots such as `test/generated`.

Deleted candidate files are represented explicitly. Deletion of a protected
file is rejected in the same way as modification.

## 7. Trusted Assets

These assets always come from the host:

- all contracts used in the run;
- `.harness/**`, including verdicts and run-control state;
- contract selection configuration;
- modules named by `--properties`;
- CI definitions, `CODEOWNERS`, and gate launch scripts;
- Harness gate implementation and its dependencies;
- configured trusted tests;
- runtime secrets required by gate checks.

The implementation must not depend only on matching filenames inside the agent
sandbox. Trusted assets are excluded from that sandbox and injected separately
into the gate sandbox.

## 8. Driver Model

The current local `AgentDriver` abstraction becomes an orchestration boundary:

- a sandbox driver starts and communicates with the persistent agent sandbox;
- a candidate collector returns a host-owned change set after each command;
- a gate sandbox factory creates a clean environment per attempt;
- a sandbox execution adapter supplies raw evidence to gate plugins.

`runLoop` remains responsible for retry and escalation policy, but it invokes a
candidate runner that performs agent execution, collection, and external gate
validation. It must not call local `gate.run` against an agent-modified host
directory.

The Daytona client, sandbox factory, filesystem operations, process execution,
clock, random execution ID source, and host workspace applier are dependency
injected so unit tests do not require a running Daytona service.

## 9. Host Workspace Application

A passing gate report authorizes only the exact `CandidateChangeSet` that was
validated. It does not authorize overwriting newer host changes.

Before writing, the host workspace applier re-hashes every affected existing
path and verifies that it still matches the run baseline. For additions, it
verifies that the destination still does not exist. Any mismatch produces a
`workspace_conflict` escalation and writes no candidate file.

The applier then:

1. writes candidate additions and modifications to a host temporary staging
   directory;
2. records intended additions, replacements, and deletions in a recovery
   journal;
3. moves existing affected files into a backup area;
4. renames staged files into place;
5. removes the backup and journal only after every operation succeeds;
6. restores the backup if an in-process operation fails.

If the process terminates during application, the next Harness invocation
detects the recovery journal and refuses another run until it has completed
automatic rollback or reported a precise recovery error.

This provides transactional application and crash recovery without requiring a
clean Git worktree. Unrelated user changes are not reverted or included.

## 10. Gate Plugin Adaptation

Command-like plugins must use an execution abstraction instead of directly
calling `node:child_process`:

- `command`, `boot`, and `structure` execute inside the gate sandbox;
- `http` either targets a service started inside that sandbox or uses a
  sandbox preview endpoint selected by the host;
- `review` stays entirely on the host;
- `invariant` code and property registration stay trusted and execute through
  a host-controlled strategy.

The first implementation may support command-like checks first, provided an
unsupported plugin returns `error` with a precise message. Unsupported checks
must never silently fall back to the agent sandbox or host candidate directory.

## 11. Contract Integrity

`contractHash` must use deterministic recursive canonicalization. The current
top-level JSON replacer omits nested object fields and permits nested contract
tampering to escape detection.

Canonicalization must:

- recursively sort object keys;
- preserve array order;
- exclude only `frozen`, `frozen_at`, and `hash` at the contract root;
- reject unsupported values rather than hashing ambiguous representations.

Nested expectation changes must produce a different hash.

## 12. Failure Semantics

The following conditions produce `error`:

- Daytona creation, upload, download, list, or execution failure;
- gate sandbox timeout or unexpected termination;
- missing or mismatched execution ID;
- malformed raw evidence;
- unsupported gate execution type;
- failure to reconstruct the trusted baseline;
- transactional candidate application or recovery failure.

Candidate policy violations produce deterministic failed diagnostics and are
eligible for retry unless escalation policy stops the run.

Concurrent host changes to candidate-affected paths produce
`workspace_conflict` escalation rather than agent feedback because another
actor, not the candidate, changed the trusted input.

Diagnostics sent to the agent contain contract IDs, violations, relevant
candidate-relative paths, and remediation guidance. They exclude credentials,
host absolute paths, and raw environment dumps.

## 13. Observability

Host run logs record:

- run and attempt identifiers;
- agent and gate sandbox identifiers;
- candidate manifest hash and changed paths;
- policy rejection reasons;
- gate execution IDs and durations;
- final host-computed report and escalation action;
- cleanup outcomes.

Logs must not record model tokens, Daytona API keys, gate secrets, or complete
environment maps. Existing Langfuse instrumentation applies only to agent
query observability and cannot influence gate decisions.

## 14. Cleanup and Recovery

Gate sandboxes are always deleted after a round. Cleanup failure is logged but
does not change an already computed failing result into a pass.

The agent sandbox is deleted when the run ends. An explicit debug option may
retain it after failure or escalation and must print its ID. Retention is off
by default.

The host stores enough non-secret run metadata to explain an escalation, but
does not store unvalidated candidate files outside temporary storage. Temporary
candidate storage is removed after application or run termination.

## 15. Acceptance Criteria

1. `harness run --driver claude` and `--driver command` use Daytona for agent
   execution by default.
2. Retry rounds reuse one agent sandbox.
3. Every gate round uses a newly created sandbox with no agent or model
   credentials.
4. Contracts, verdicts, trusted tests, configuration, and gate code always come
   from the host.
5. Agent changes to protected assets cannot affect gate selection or results.
6. Agent Git metadata, patches, hashes, and success messages are ignored as
   decision inputs.
7. Candidate files are collected and hashed by the host through Daytona APIs.
8. Gate evidence is interpreted and aggregated by host `GateCore`.
9. Failed, blocked, timed-out, or infrastructure-error runs do not modify the
   host workspace.
10. Passing candidate changes are transactionally applied only if all affected
    host paths still match the original baseline.
11. Nested contract tampering is detected.
12. Retry limits and repeated-failure escalation still work.
13. Sandbox cleanup occurs on success, failure, blocked review, and thrown
    errors.
14. Unit tests run with injected fakes and no Daytona service.
15. A separately invoked integration test covers a real local Daytona agent
    and gate round.
16. Concurrent edits to affected host paths cause `workspace_conflict` without
    overwriting user changes.
17. Interrupted candidate application is detected and recovered or fails
    closed on the next invocation.

## 16. Delivery Scope

The initial delivery includes:

- Daytona agent execution for Claude and command drivers;
- persistent agent sandbox lifecycle;
- host baseline and candidate collection;
- protected path enforcement;
- fresh gate sandbox creation per round;
- sandbox execution support for command-like gates;
- host-side report aggregation and loop control;
- pass-only transactional host workspace application and conflict detection;
- recursive contract hashing;
- unit tests and an explicit local Daytona integration test;
- CLI and runbook updates.

The initial delivery excludes:

- general outbound network policy enforcement;
- distributed or remote gate services;
- cryptographic signing by an external authority;
- automatic support for every possible custom plugin;
- dependency or build-cache optimization across gate sandboxes.

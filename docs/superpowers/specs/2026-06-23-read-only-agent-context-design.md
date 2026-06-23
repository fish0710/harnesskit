# Read-Only Agent Context Design

## Goal

Add a sandbox policy layer for files that the implementation agent may read as task context but may not publish or modify.

## Current Behavior

Harness currently has two effective path classes:

- `candidateRoots`: uploaded to the Agent sandbox and eligible for candidate publication.
- `protectedPaths`: excluded from candidate publication and also excluded from the Agent upload.

Paths outside both classes are hidden from the Agent. Therefore `protectedPaths` are host-only/hidden, not read-only.

## Desired Policy Classes

- Candidate: visible to the Agent and publishable when changed.
- Read-only: visible to the Agent as context, verified against the host baseline, and never publishable.
- Protected: host-owned and hidden from the Agent.
- Ignored: not uploaded and not collected.

Default generated Harness configs should treat `contracts`, `test/gates`, `.harness`, and `harness.config.json` as protected. They should treat `AGENTS.md`, `docs/specs`, and `docs/plans` as read-only context. Implementation-owned source and generated artifact roots remain `candidateRoots`.

## Design

Add `sandbox.readOnlyPaths` to `SandboxPolicy`, with strict path normalization and the same host filesystem alias protection used for protected paths. Protected paths take precedence over read-only paths. Read-only paths take precedence over candidate roots so a subtree such as `src/specs` can be visible but not writable even when `src` is a candidate root.

Agent upload uses a new visible-file rule: candidate files plus read-only files, excluding protected files. Candidate collection uses a mutable-file rule: only candidate paths may become `CandidateSnapshot` files and operations. If the Agent changes, deletes, or adds a file under `readOnlyPaths`, collection fails with a candidate-integrity error before any Gate evaluation or host publication.

Gate assembly and host-local gate materialization must use the mutable candidate rule when removing baseline files before applying candidate bytes. Read-only files stay host-controlled in Gate sandboxes and are verified like protected files.

## Documentation And Plugin Guidance

Update user-facing docs and the `harness-prep` plugin references so future prep agents classify paths as candidate, read-only context, protected, or hidden. The plugin should no longer tell agents to put task docs into `candidateRoots` just so the implementation agent can read them.

## Testing

Add focused tests for policy parsing/defaults, visible file selection, read-only mutation rejection, missing read-only rejection, candidate operation exclusion, and host/gate materialization behavior. Run focused compiled tests first, then the full project check.

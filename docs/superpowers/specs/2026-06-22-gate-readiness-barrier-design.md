# Gate Readiness Barrier Design

## Current Request

Harness preparation currently relies on plugin skill guidance to help an agent
create `contracts/` and `harness.config.json`. In real runs, some generated
gates are syntactically valid but cannot execute inside the Daytona Gate
sandbox. A common example is a setup command that uses `nvm` as if it were a
binary, or assumes a Node/package-manager tool exists in Gate when it does not.
Those failures are discovered only after the implementation agent has already
started work, which turns a configuration/runtime problem into wasted agent
attempts.

## Goal

Add a Gate readiness barrier before `harness run` so Harness can prove that the
selected machine gates are executable in the same kind of Gate sandbox that the
run loop will use.

The barrier should:

- make Gate runtime assumptions explicit in the harness-prep skill and scaffold
  docs;
- statically flag setup and contract commands that are known to be invalid in
  the default snapshots;
- create a short-lived Gate sandbox and exercise `gateSetup` plus selected
  remote contracts before any mutating agent is started;
- classify runtime/configuration failures separately from expected product-red
  gates;
- prevent setup/toolchain errors from being fed back to the implementation
  agent as if they were implementation failures.

## Non-Goals

- Do not replace CI or final merge protection.
- Do not make the Gate sandbox trusted. It remains an evidence collection
  environment; the host still classifies evidence.
- Do not start a Claude or command agent during readiness checks.
- Do not automatically rewrite user contracts or setup commands.
- Do not install missing global tools during the contract stage after Gate
  network policy has been applied.
- Do not make `harness check` silently switch from local execution to Daytona.
  Existing local check semantics remain available.

## Must Preserve

- Agent and Gate sandboxes remain separate.
- Gate sandboxes never receive model credentials or Claude tooling.
- Contracts, config, `.harness`, CI, and trusted gate runners remain
  host-owned/protected.
- A passing readiness check means "the gate can run", not "the product is
  already correct".
- A failing product assertion can still be acceptable before an agent run if it
  is an intended red gate and there are no readiness errors.

## Recommended Approach

Implement a first-class CLI command:

```bash
harness preflight gate --dir contracts --config harness.config.json --json
```

This command is the new required pre-run barrier for Daytona-backed execution.
It should run before:

```bash
harness run "<task>" --driver claude
harness run "<task>" --driver command --agent-cmd "<runner>"
harness run --driver claude
```

`harness contract validate` and `harness check` remain useful, but they are no
longer sufficient proof that remote Gate execution will work.

## Alternatives Considered

### Skill-Only Guidance

Update the harness-prep skill with stronger Node, Python, package manager, and
`nvm` rules.

This is necessary but insufficient. It reduces bad generations but cannot prove
the generated commands work in the actual snapshot. Agents can still produce
valid-looking but non-executable setup.

### Expand Default Gate Snapshot

Preinstall more runtimes and legacy toolchains in `harness-gate-runtime-latest`.

This improves common cases and current work is already moving that way for Node
14/npm 6. It still does not handle every project, and it can hide the core
problem: generated contracts need to be tested against the actual Gate runtime.

### First-Class Gate Readiness Command

Add a host-controlled command that creates a real Gate sandbox, assembles the
same workspace view used by `run`, runs setup, then executes selected remote
contracts with extra runtime-error classification.

This is the recommended option because it turns runtime uncertainty into a
pre-run invariant.

## Architecture

### New Command Surface

Add a `preflight` command group:

```text
harness preflight gate [--dir contracts] [--config harness.config.json]
                       [--stage <stage>] [--changed a,b]
                       [--properties <module>] [--base-url <url>]
                       [--json] [--retain-on-failure]
```

The command should reuse existing contract loading, frozen contract
verification, selection, sandbox policy loading, plugin registration, and
Daytona provider creation.

`--stage` and `--changed` should select contracts consistently with
`harness check` and `harness run`.

### Static Runtime Lint

Before creating Daytona resources, the command should inspect `agentSetup`,
`gateSetup`, and selected contract commands for common Gate runtime mistakes:

- bare `nvm use` without sourcing `/usr/local/nvm/nvm.sh`;
- `nvm install` in ordinary Gate setup or contracts;
- `claude` in Gate setup or contracts;
- `git`, `pnpm`, `yarn`, or `bun` without an explicit setup/install step;
- HTTP loopback contracts without a service-oriented `gateSetup`;
- command contracts that appear to fetch dependencies after Gate network policy
  would be applied.

Static lint should produce warnings or errors with specific remediation text.
Hard errors should cover known-invalid patterns such as bare `nvm use` and
Gate-side `claude`.

### Runtime Gate Rehearsal

The runtime phase should create a fresh Gate sandbox from the configured Gate
snapshot, upload the current host workspace as the candidate workspace, run
`gateSetup`, apply the same Gate network rule used by `harness run`, and execute
the selected non-host-local contracts through the normal `GateCore` plugins.

This intentionally uses the current host workspace as the candidate. The
purpose is readiness, not correctness. If a contract fails because the current
implementation is not done yet, that is an expected product-red result, not a
readiness error.

Host-local contracts such as `miniprogram` are outside the Gate sandbox. The
preflight should list them as "not covered by Gate runtime preflight" and keep
their existing local review/check path separate.

### Runtime Failure Classification

The existing command plugin classifies a non-zero exit code as `fail`. That is
correct for normal gate semantics, but preflight needs stronger interpretation.
The preflight report should scan setup results and command evidence for runtime
failure signatures and classify them as readiness errors:

- exit 127 or shell text like `command not found`;
- `nvm: not found`, missing `nvm.sh`, or missing requested Node version;
- missing `node`, `npm`, `npx`, `python3`, or `pip3`;
- missing package-manager commands;
- missing npm scripts needed by setup or contract commands;
- module/dependency resolution errors during setup;
- network fetch attempts during the contract stage after network block.

Readiness errors should block `harness run`. Product-red failures can be
allowed only when they are not runtime/setup failures and the user understands
they are the expected work for the implementation agent.

### Result Model

Add a preflight-specific report shape:

```ts
interface GatePreflightReport {
  outcome: "ready" | "not_ready" | "blocked";
  staticFindings: PreflightFinding[];
  setup: PreflightStep[];
  selectedContracts: string[];
  remoteContracts: string[];
  hostLocalContracts: string[];
  gateReport?: GateReport;
  readinessErrors: PreflightFinding[];
  expectedRedGates: string[];
  sandbox?: { id: string; snapshot: string; retained: boolean };
}
```

Exit codes:

- `0`: Gate runtime is ready. Contracts may have expected product-red failures
  only if the command has a clear way to mark/allow them.
- `1`: readiness error or unexpected runtime/config failure.
- `2`: review/blocked state that requires human decision.

The first implementation can be stricter: any product `fail` yields exit `1`,
but JSON output must distinguish `readinessErrors` from ordinary contract
failures. A later flag can support `--allow-red-gates`.

## Data Flow

1. Load `harness.config.json` and sandbox policy.
2. Load contracts, schema-validate them, and verify frozen hashes.
3. Select contracts using `--stage`, `--changed`, or all contracts.
4. Run static runtime lint.
5. If hard lint errors exist, stop before creating Daytona resources.
6. Split selected contracts into remote and host-local groups.
7. If remote contracts exist:
   - create a short-lived Gate sandbox from `HARNESS_DAYTONA_GATE_SNAPSHOT` or
     `harness-gate-runtime-latest`;
   - upload the host workspace to `/workspace/candidate`;
   - run `gateSetup`;
   - apply the same loopback-aware Gate network policy used by `run`;
   - execute remote contracts through `GateCore` with Daytona execution target;
   - delete the sandbox unless retained for diagnosis.
8. Classify findings into readiness errors, product failures, blocked review,
   and informational host-local coverage gaps.
9. Render pretty and JSON reports.

## Skill And Scaffold Updates

Update `plugins/harness-prep/skills/harness-prep` references so the preparation
flow requires:

```bash
harness contract validate contracts
harness check --dir contracts --config harness.config.json --json
harness preflight gate --dir contracts --config harness.config.json --json
harness status --dir contracts
```

The skill should state that local `harness check` proves contract semantics on
the host, while `harness preflight gate` proves that remote Gate setup and
selected remote contracts can execute in the Daytona Gate snapshot.

Update scaffolded `AGENTS.md` so implementation agents do not treat local
`harness check` as the whole readiness story.

## Error Handling

- Missing `DAYTONA_API_KEY` is a readiness infrastructure error.
- Blank `HARNESS_DAYTONA_GATE_SNAPSHOT` is a readiness configuration error.
- `gateSetup` failure is a readiness error unless the command is explicitly
  designed as a product assertion, which setup should not be.
- Contract command spawn/evidence errors are readiness errors.
- Contract command exit mismatches are product failures unless runtime-failure
  classification detects missing tools or setup.
- Unknown contract types remain gate errors and block readiness.
- Frozen contract hash failures block before Daytona resources are created.
- Sandbox cleanup failure blocks readiness unless the sandbox is intentionally
  retained for diagnosis and the report records that.

## Testing Strategy

Unit tests:

- contract selection is shared with existing `check` behavior;
- static lint catches bare `nvm use`, Gate-side `claude`, and missing default
  tools;
- static lint does not flag valid sourced `nvm use`;
- runtime report separates setup failure from product command failure;
- exit 127 and `command not found` become readiness errors;
- host-local contracts are reported as not Gate-covered;
- cleanup runs on success and failure;
- `--json` includes selected contracts, snapshot name, and readiness errors.

Integration tests:

- with a fake SandboxProvider, preflight creates a Gate sandbox, uploads files,
  runs setup, applies network policy, runs contracts, and deletes the sandbox;
- optional real Daytona integration exercises the default latest Gate snapshot
  with a simple Node command and a sourced `nvm use 14.21.3` setup.

Documentation verification:

- update usage docs and harness-prep references;
- ensure the documented pre-run checklist includes `preflight gate`;
- update troubleshooting text so setup/toolchain errors are fixed before agent
  execution rather than retried by the agent.

## Rollout

1. Add the internal preflight runner and tests behind the new command.
2. Wire `harness preflight gate` into CLI help and usage docs.
3. Update harness-prep skill references and scaffolded `AGENTS.md`.
4. Keep `harness run` behavior unchanged initially, but the prep skill must not
   start a Daytona agent run until the preflight is ready.
5. After adoption, consider making `harness run --driver claude|command` print a
   warning when no recent matching preflight record exists.

## Open Decisions

- Whether `harness preflight gate` should fail on all product-red contracts by
  default, or support `--allow-red-gates` in the first release.
- Whether preflight reports should be persisted under `.harness/preflight/` or
  only printed. Persisting would make "recent matching preflight" warnings more
  reliable.
- Whether host-local gates need a separate `harness preflight host` command in
  this release or a later one.

## Acceptance Criteria

- A generated contract that uses bare `nvm use` is rejected before `harness run`.
- A Gate setup command that assumes a missing package manager is rejected before
  `harness run`.
- A valid sourced Node 14 Gate setup can pass readiness on the updated Gate
  snapshot.
- A product test failure is reported separately from setup/toolchain failure.
- The harness-prep skill and scaffolded guidance require Gate preflight before
  starting a Daytona implementation agent.

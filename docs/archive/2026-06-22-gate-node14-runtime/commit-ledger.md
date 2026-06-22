# Commit Ledger

Base branch: `main`

Working branch: `main`

Base commit before this archive:

```text
4298b75 fix: persist daytona claude transcripts
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers the Gate snapshot Node 14 runtime correction:

- preinstall Node 14.21.3/npm 6.14.18 in the Gate Docker image;
- keep Node 22.14.0 as the default Gate runtime;
- bump the Gate immutable release to `node-22.14.0-r2`;
- keep `harness-gate-runtime-latest` as the stable default snapshot name;
- verify legacy Node in Gate image and snapshot preflight;
- preserve the "Gate contains no Claude" invariant;
- install legacy Node in the Agent-runtime cleanup fallback before creating
  Gate latest;
- document nvm source/use/install boundaries in the harness-prep skill.

## Key Files

```text
images/daytona/gate/Dockerfile
src/harness/sandbox/toolchain.ts
src/tools/daytona-gate-snapshot.ts
test/daytona-gate-snapshot.test.ts
test/daytona-toolchain.test.ts
plugins/harness-prep/skills/harness-prep/references/sandbox-snapshots.md
docs/archive/2026-06-22-gate-node14-runtime/README.md
docs/archive/2026-06-22-gate-node14-runtime/verification.md
docs/archive/2026-06-22-gate-node14-runtime/commit-ledger.md
```

## Review Before Archive

Manual diff review before archive checked:

- `/usr/local/bin/node`, `/usr/local/bin/npm`, and `/usr/local/bin/npx` remain
  linked to Node 22.14.0.
- Node 14.21.3 is installed into `/usr/local/nvm` only during image build or
  snapshot publish under root privileges.
- Runtime Gate setup is expected to use `nvm use`, not `nvm install`.
- Gate snapshot preflight still asserts `! command -v claude`.
- The skill documentation does not recommend opening Gate contract-stage
  network or mutating Agent sandbox HOME as a fix.

No blocking review findings were found.

## Verification Before Commit

```text
npm run build && npm run test
git diff --check
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:gate
fresh Gate sandbox Node 14/npm 6 probe
target project root gateSetup smoke
```

Expected result:

```text
tests 445
pass 445
snapshot state active
node v14.21.3
npm 6.14.18
target root gateSetup exit 0
```

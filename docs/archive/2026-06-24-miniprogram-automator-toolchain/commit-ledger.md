# Commit Ledger

Base branch: `main`

Working branch: `codex/miniprogram-automator-toolchain`

Pre-archive base:

```text
42ff5d5 fix: remove claude command timeout
```

Archive commit: the commit containing this ledger.

## Scope

This archive covers making `miniprogram-automator@0.12.1` a Harness-owned
toolchain dependency for host-local miniprogram gates:

- add `miniprogram-automator@0.12.1` to Harness dependencies;
- resolve the installed automator package from `src/plugins/miniprogram.ts`;
- inject `NODE_PATH` into trusted miniprogram runner execution;
- keep runner environment explicit and minimal;
- update examples and guidance so runners no longer install automator during a
  gate;
- document the ESM runner `createRequire(...)` requirement;
- add regression tests for runner dependency injection and documentation.

## Key Files

```text
src/plugins/miniprogram.ts
test/miniprogram-plugin.test.ts
test/miniprogram-templates.test.ts
examples/miniprogram/README.md
examples/miniprogram/test/gates/miniprogram-template-helpers.js
docs/architecture/gate-plugin-guide.md
plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md
package.json
package-lock.json
docs/archive/2026-06-24-miniprogram-automator-toolchain/
```

## Verification Before Archive

```text
npm run build
node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-cli.test.js dist/test/miniprogram-templates.test.js
node --test dist/test/host-gate.test.js dist/test/remote-gate.test.js dist/test/daytona-environment.test.js
npm test
npm install -g .
harness --help
git diff --check
```

Observed result:

```text
targeted miniprogram tests: tests 58, pass 58, fail 0
host/remote/daytona boundary tests: tests 80, pass 80, fail 0
full suite: tests 578, pass 578, fail 0
local CLI install: npm install -g . exit 0
harness --help exit 0
git diff --check exit 0
```

## Residual Risk

The fix removes runtime npm installation from the miniprogram gate path, but it
does not change WeChat DevTools host requirements. Users still need local
DevTools installed, automation enabled, and a valid compiled `projectPath`.

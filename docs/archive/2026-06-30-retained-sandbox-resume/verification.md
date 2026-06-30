# Verification

## Targeted Suites

命令：

```bash
npm run build
node --test dist/test/resume.test.js
node --test dist/test/daytona-environment.test.js
node --test dist/test/harness-series.test.js
node --test dist/test/cli-run-record.test.js
```

结果：

```text
resume.test.js: 18/18 pass
daytona-environment.test.js: 45/45 pass
harness-series.test.js: 59/59 pass
cli-run-record.test.js: 12/12 pass
```

覆盖重点：

- retained run resume request fail-closed baseline validation;
- interrupted `running` run recovery from `claudeStreamPath`;
- `session_id` and `sessionId` stream result recovery;
- attached sandbox Gate-first pass and Gate-fail Claude resume;
- series ledger stale/completed run overwrite prevention;
- `.harness` runtime records ignored for current dirty checks.

## Full Suite

Sandboxed command:

```bash
npm run check
```

结果：647 pass, 4 fail. 4 个失败均为本地权限沙箱禁止 `127.0.0.1`
listener：

```text
listen EPERM: operation not permitted 127.0.0.1
```

无沙箱/提升权限重跑同一命令：

```bash
npm run check
```

结果：

```text
tests 651
pass 651
fail 0
exit 0
```

## CLI Help

命令：

```bash
node dist/src/cli.js help | rg "harness runs resume <runId>"
```

结果：

```text
harness runs resume <runId> [--dir d] [--config f] [--max-attempts n] [--max-ms ms] [--verbose]
```

## Diff Checks

命令：

```bash
git diff --check
git diff --name-only
```

结果：

```text
git diff --check exit 0
```

变更范围：

```text
docs/architecture/daytona-sandbox-gate.md
docs/daytona-local-claude-code-runbook.md
docs/usage.md
src/cli.ts
src/harness/resume.ts
src/harness/sandbox/environment.ts
src/harness/series.ts
test/cli-run-record.test.ts
test/daytona-environment.test.ts
test/harness-series.test.ts
test/resume.test.ts
```

## Review Follow-up

Subagent review reported three important issues; all were incorporated and
covered by tests:

- fail closed when source/current Git HEAD or dirty state is unknown;
- recover camelCase `sessionId` in interrupted stream recovery;
- prevent stale/completed series ledger entries from being overwritten by an
  older retained resume.

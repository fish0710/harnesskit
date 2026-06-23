# Verification

## TDD Red Checks

新增测试先失败，确认覆盖缺失能力：

```bash
npm run build && node --test dist/test/sandbox-policy.test.js
```

结果：

```text
Property 'readOnlyPaths' does not exist on type 'SandboxPolicy'
```

```bash
npm run build && node --test dist/test/sandbox-workspace.test.js
```

结果：

```text
Module '../src/harness/sandbox/workspace.js' has no exported member 'mutableCandidateFiles'
```

```bash
npm run build && node --test dist/test/daytona-environment.test.js dist/test/host-gate.test.js dist/test/preflight-runtime.test.js
```

结果：

```text
3 failures: read-only context not uploaded/preserved/verified
```

## Focused Green Checks

命令：

```bash
npm run build && node --test dist/test/sandbox-policy.test.js
npm run build && node --test dist/test/sandbox-workspace.test.js
npm run build && node --test dist/test/daytona-environment.test.js dist/test/host-gate.test.js dist/test/preflight-runtime.test.js
npm run build && node --test dist/test/scaffold.test.js dist/test/daytona-claude.test.js dist/test/sandbox-policy.test.js
```

结果：

```text
sandbox-policy: tests 41, pass 41, fail 0
sandbox-workspace: tests 35, pass 35, fail 0
daytona/host/preflight focused set: tests 55, pass 55, fail 0
scaffold/daytona/policy focused set: tests 57, pass 57, fail 0
```

覆盖重点：

- default/custom `readOnlyPaths` parsing and normalization;
- protected -> read-only -> candidate -> ignored precedence;
- Agent-visible read-only context upload;
- read-only add/modify/delete rejection during candidate collection;
- mutable candidate diff remains publication-only;
- Gate and host-local materialization preserve baseline read-only files.

## Plugin And Skill Validation

命令：

```bash
python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep
```

结果：

```text
Plugin validation passed: /Users/zhongyy40/workspace/harnesscli/harness/plugins/harness-prep
Skill is valid!
```

## Full Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 566
pass 566
fail 0
```

## Whitespace

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

## Codex Plugin Reinstall

命令：

```bash
python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/harness-prep

codex plugin add harness-prep@harnesskit
codex plugin list | rg -A2 -B2 'harness-prep@harnesskit|Marketplace `harnesskit`'
```

结果：

```text
Updated plugin version: 0.1.0+codex.20260623064758 -> 0.1.0+codex.20260623081235
Added plugin `harness-prep` from marketplace `harnesskit`.
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623081235
```

缓存路径：

```text
/Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623081235
```

缓存抽查确认包含：

- `readOnlyPaths`
- `AGENTS.md`, `docs/specs`, `docs/plans`
- `candidate, read-only, and protected paths`
- `The agent may read but not publish`

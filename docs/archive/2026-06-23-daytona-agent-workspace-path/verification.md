# Verification

## RunStore Evidence

目标项目：

```text
/Users/zhongyy40/dev/miniprogram
```

目标记录：

```text
.harness/runs/2026-06-23T08-26-56-063Z-ea94df62.json
```

确认点：

```text
attempts[].agentSandboxId = 35c74174-1946-48a0-a5af-7cbd11b52c7f
agent.upload.end files=5
candidate.collect.end operations=23 files=23
claudeConfigDir=/home/daytona/.claude
claudeStreamPath=/harness-observability/attempt-<n>/claude-stream.jsonl
```

用户随后在 sandbox 中确认项目文件位于：

```text
/home/daytona/workspace/candidate
```

## Build And Tests

命令：

```bash
npm run build && node --test \
  dist/test/daytona-sandbox.test.js \
  dist/test/daytona-environment.test.js \
  dist/test/daytona-claude.test.js \
  dist/test/sandbox-workspace.test.js
```

结果：

```text
tests 110
pass 110
fail 0
```

另一次包含 `dist/test/preflight-runtime.test.js` 的 fresh run 失败：

```text
tests 125
pass 124
fail 1
host-local miniprogram preflight warms and verifies DevTools before agent work
AssertionError: 2 !== 3
```

该失败来自未 staged 的工作树变更
`test/preflight-runtime.test.ts`，它把 `calls.length` 期望从 `2` 改为 `3` 并
新增 `cli quit` 断言；该文件未纳入本提交。另有未 staged
`test/miniprogram-plugin.test.ts` 变更也未纳入本提交。

## Documentation Search

命令：

```bash
rg -n "/workspace/candidate" plugins docs README.md src -g '!node_modules' -g '!dist'
```

结果：

```text
Remaining uses are either code/test logical-root references or documentation
that now explicitly distinguishes Harness logical root, Daytona SDK path, and
interactive shell path.
```

## Plugin Verification

Commands:

```bash
python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py \
  --marketplace-path /Users/zhongyy40/workspace/harnesscli/harness/.agents/plugins/marketplace.json

codex plugin add harness-prep@harnesskit
```

结果：

```text
Skill is valid!
Plugin validation passed
Updated plugin version: 0.1.0+codex.20260623082128 -> 0.1.0+codex.20260623085251
Added plugin `harness-prep` from marketplace `harnesskit`.
Installed plugin root: /Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623085251
codex plugin list shows harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623085251
cache grep confirms /home/daytona/workspace/candidate guidance is present
```

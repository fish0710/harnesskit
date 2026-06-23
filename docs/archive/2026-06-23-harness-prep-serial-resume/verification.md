# Verification

## Plugin Reinstall

命令：

```bash
codex plugin add harness-prep@harnesskit
codex plugin list | rg -A3 -B3 'harness-prep|harnesskit'
```

结果：

```text
Added plugin `harness-prep` from marketplace `harnesskit`.
harness-prep@harnesskit  installed, enabled  0.1.0+codex.20260623034310
```

安装缓存：

```text
/Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623034310
```

缓存抽查：

```bash
rg -n 'Interrupted Series Recovery|Dependency Manifest Boundaries|Do not change `series\.id`|root `package\.json`' \
  /Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623034310
```

结果确认新缓存包含：

- `Interrupted Series Recovery`
- `Do not change series.id`
- `Dependency Manifest Boundaries`
- root `package.json` / lockfile protection guidance

`codex plugin list` 同时输出过 PATH alias warning：

```text
WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)
```

该 warning 不影响插件安装状态；列表仍显示 `harness-prep@harnesskit installed,
enabled`。

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

## Build

命令：

```bash
npm run build
```

结果：

```text
tsc -p tsconfig.json
exit 0
```

## Targeted Series Tests

命令：

```bash
node --test dist/test/harness-series.test.js dist/test/cli-series.test.js
```

结果：

```text
tests 57
pass 57
fail 0
```

覆盖重点：

- completed matching `taskHash` skip 语义；
- terminal `blocked` / `escalated` / `error` stop 语义；
- `pending` / `running` rerun 语义；
- CLI no-task series path 和 skip 输出。

## Full Test Suite

命令：

```bash
npm run check
```

沙箱内第一次运行有 2 个 HTTP adapter 测试因为 `listen EPERM 127.0.0.1`
失败；按权限流程在沙箱外重跑同一命令。

提权重跑结果：

```text
tests 553
pass 553
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

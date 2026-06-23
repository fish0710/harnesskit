# Verification

## Full Test Suite

命令：

```bash
npm run check
```

结果：

```text
@harness/gate-core@0.2.0 check
npm run build && npm run test

tsc -p tsconfig.json
tests 555
pass 555
fail 0
exit 0
```

覆盖重点：

- `miniprogram` managed DevTools 启动后等待 automation TCP port ready；
- host-local miniprogram gates 仍与 Daytona remote gate 流程兼容；
- 小程序失败会反馈给 agent，重复失败会升级到 `human_review_contract`；
- `examples/miniprogram` runner 模板语法可通过 Node syntax check；
- `harness-prep` skill 必须引用小程序门禁指南；
- 小程序指南必须包含 host-local 执行模型、`page.callMethod()` 反模式、
  raw `page.data` 反模式、uni-app/Vue 注意事项和 `trigger("click")` 指导。

## Targeted Regression Coverage

命令：

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js dist/test/miniprogram-templates.test.js
```

结果：

```text
tests 54
pass 54
fail 0
```

重点测试：

- `miniprogram plugin waits for managed DevTools WebSocket before runner`
  - fake DevTools CLI 先返回 0，再延迟监听 `autoPort`；
  - runner 只有在端口可连接后才退出 0；
  - 无 readiness wait 时该用例会失败。
- `miniprogram plugin does not forward ambient env to local managed DevTools startup`
  - 保持最小环境传递策略；
  - 测试 CLI 在隔离环境里自己启动临时 TCP listener，避免 readiness wait 误判。
- `miniprogram prep skill documents host-local runner rules`
  - 锁住 skill/README 对 host-local、uni-app/Vue、`page.callMethod()`、
    `page.data`、`trigger("click")` 和 helper exports 的说明。

## Plugin Verification

命令：

```bash
python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep

codex plugin add harness-prep@harnesskit --json
codex plugin list | rg -n 'harness-prep'
```

结果：

```text
Skill is valid!
Plugin validation passed: /Users/zhongyy40/workspace/harnesscli/harness/plugins/harness-prep
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623064758
```

缓存路径：

```text
/Users/zhongyy40/.codex/plugins/cache/harnesskit/harness-prep/0.1.0+codex.20260623064758
```

## CLI Refresh

命令：

```bash
npm install -g .
harness --help
```

结果：

```text
up to date
harness --help exit 0
```

## Whitespace Check

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

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

- `miniprogram` managed DevTools 启动后等待 automation WebSocket 返回
  `Tool.getInfo.SDKVersion`；
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

- `miniprogram plugin waits for managed DevTools automation protocol before runner`
  - fake DevTools CLI 先返回 0；
  - runner 只有在 automation 协议返回 `SDKVersion` 后才启动；
  - 无 protocol readiness wait 时该用例会失败。
- `miniprogram plugin does not forward ambient env to local managed DevTools startup`
  - 保持最小环境传递策略；
  - 测试 CLI 在隔离环境里自己启动临时 readiness endpoint，避免 startup wait
    误判。
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

## Follow-up Verification: Protocol Readiness And Doctor Cleanup

Review 发现的问题：

```text
npx -y node@20 -e "console.log(process.version, typeof WebSocket)"
v20.20.2 undefined
```

因此不能只依赖 Node 全局 `WebSocket`；Harness 需要在 Node 20 下也能探测
DevTools automation WebSocket。

RED 命令：

```bash
npm run build && node --test dist/test/miniprogram-plugin.test.js
```

RED 结果：

```text
miniprogram plugin probes automation protocol when global WebSocket is unavailable
actual: error
expected: pass
```

GREEN 命令：

```bash
npm run build && node --test \
  dist/test/miniprogram-plugin.test.js \
  dist/test/preflight-runtime.test.js \
  dist/test/miniprogram-templates.test.js
```

GREEN 结果：

```text
tests 70
pass 70
fail 0
```

全量验证：

```bash
npm run check
```

结果：

```text
tests 571
pass 571
fail 0
```

最小真实小程序验证目录：

```text
/Users/zhongyy40/workspace/miniprogram-doctor-lab
```

串行命令：

```bash
harness preflight gate --dir contracts --json
harness check --dir contracts --json
lsof -nP -iTCP:9420 -sTCP:LISTEN || true
```

结果：

```text
preflight outcome: ready
check outcome: pass, mp.behavior pass
9420 listener after preflight: none
```

插件和格式校验：

```bash
python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep

git diff --check
```

结果：

```text
Skill is valid!
Plugin validation passed
git diff --check exit 0
```

## Follow-up Verification: Host Preflight Doctor

命令：

```bash
npm run check
```

结果：

```text
@harness/gate-core@0.2.0 check
npm run build && npm run test

tsc -p tsconfig.json
tests 568
pass 568
fail 0
exit 0
```

覆盖重点：

- managed DevTools 启动前先执行 `cli islogin` 预热；
- `cli auto` 使用短 DevTools readiness timeout，避免冷启动卡住时消耗完整契约
  timeout；
- Gate preflight 会对 host-local miniprogram 契约运行 DevTools doctor；
- `hostLocal.<id>.devtools` readiness error 会在创建 Agent sandbox 前阻断；
- pretty/json preflight 输出区分 host-local readiness 与 remote Gate sandbox；
- `harness-prep` 小程序指南要求先跑 `harness preflight gate` 并解释
  `hostLocal.<id>.devtools`。

目标项目实测目录：

```text
/Users/zhongyy40/dev/miniprogram
```

命令：

```bash
harness preflight gate --dir contracts --config harness.config.json --stage mp-auto --json
```

结果：

```json
{
  "outcome": "ready",
  "selectedContracts": ["mp.behavior"],
  "remoteContracts": [],
  "hostLocalContracts": ["mp.behavior"],
  "readinessErrors": [],
  "productFailures": []
}
```

实际 gate check 命令：

```bash
harness check --dir contracts --config harness.config.json --stage mp-auto --json
```

结果：

```text
outcome: fail
id: mp.behavior
status: error
errorReason: 小程序项目目录不存在: dist/build/mp-weixin
```

该实测确认当前 Harness 侧不再卡在 `ws://127.0.0.1:9420` automation readiness；
后续失败属于业务工作区缺少构建产物。

插件校验与刷新：

```bash
python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep

python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep

codex plugin add harness-prep@harnesskit --json
codex plugin list
```

结果：

```text
Skill is valid!
Plugin validation passed: /Users/zhongyy40/workspace/harnesscli/harness/plugins/harness-prep
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260623082128
```

格式检查：

```bash
git diff --check
```

结果：

```text
exit 0
```

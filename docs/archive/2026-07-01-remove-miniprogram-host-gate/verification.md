# Verification

验证日期：2026-07-01

## Commands

```bash
npm run build && node --test dist/test/loader-selector.test.js dist/test/preflight-runtime.test.js dist/test/preflight-render.test.js dist/test/daytona-environment.test.js dist/test/remote-gate.test.js dist/test/gate.test.js dist/test/cli-entrypoint.test.js
```

结果：exit 0，133 tests pass。

```bash
npm run check
```

结果：exit 0，580 tests pass。

```bash
git diff --check
git diff --cached --check
```

结果：exit 0，无 whitespace error。

```bash
rg -n "miniprogramPlugin|checkMiniProgramHostReadiness|HARNESS_MINIPROGRAM|runHostLocalGate|isHostLocalContract|miniprogram-automator" src test package.json package-lock.json
```

结果：exit 1，无匹配。

```bash
rg -n "type: miniprogram|type=\"miniprogram\"|WeChat DevTools|微信开发者工具|小程序门禁" README.md docs/usage.md docs/architecture plugins/harness-prep src/harness/scaffold.ts examples test
```

结果：仅剩 README archive 索引、`type="miniprogram"` 已移除错误测试，以及 scaffold
测试中的禁止旧文案断言。

## Notes

- `npm run check` 在修正 scaffold 测试期望后重新运行并通过。
- 最终提交前后工作区只有未跟踪 `.DS_Store`，未纳入提交。

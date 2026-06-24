# MiniProgram Automator Toolchain Archive

归档日期：2026-06-24

当前分支：`codex/miniprogram-automator-toolchain`

## 背景

真实 `/Users/zhongyy40/workspace/miniprogram` Harness run 复盘显示，
`mp.counter` 连续失败 3 次后升级，直接错误是：

```text
failed to install miniprogram-automator@0.12.1
```

根因不是 `miniprogram-automator@0.12.1` 不存在，而是 host-local
miniprogram runner 在宿主临时工作区执行时找不到该依赖，于是临时联网
`npm install`。当执行环境无法解析 `registry.npmjs.org` 时，runner 在真正连接
WeChat DevTools 前就失败。

## 最终机制

- Harness 自身固定依赖 `miniprogram-automator@0.12.1`。
- `miniprogram` 插件启动 trusted runner 时注入 `NODE_PATH`，指向 Harness 安装的
  `node_modules`。
- CommonJS runner 可以继续 `require("miniprogram-automator")`。
- ESM runner 使用
  `createRequire(import.meta.url)("miniprogram-automator")`，因为裸 ESM
  `import "miniprogram-automator"` 不读取 `NODE_PATH`。
- target project 不再需要只为了 miniprogram gate 安装 automator，也不应让 runner
  在门禁过程中临时联网安装依赖。

## 交付物

| 产出 | 路径 |
|---|---|
| Harness-owned automator dependency injection | [miniprogram.ts](../../../src/plugins/miniprogram.ts) |
| Plugin regression coverage | [miniprogram-plugin.test.ts](../../../test/miniprogram-plugin.test.ts) |
| Template/doc regression coverage | [miniprogram-templates.test.ts](../../../test/miniprogram-templates.test.ts) |
| Miniprogram examples | [examples/miniprogram](../../../examples/miniprogram) |
| Architecture guide | [gate-plugin-guide.md](../../../docs/architecture/gate-plugin-guide.md) |
| Harness prep miniprogram guidance | [miniprogram-gates.md](../../../plugins/harness-prep/skills/harness-prep/references/miniprogram-gates.md) |
| Package metadata | [package.json](../../../package.json) |
| Lockfile | [package-lock.json](../../../package-lock.json) |
| 提交账本 | [commit-ledger.md](commit-ledger.md) |
| 验证记录 | [verification.md](verification.md) |

## 归档结论

Host-local miniprogram gates no longer depend on runtime npm network access for
`miniprogram-automator`. The automator dependency is part of the Harness
toolchain, and trusted runners receive a minimal explicit environment that can
resolve it.

## Residual Risk

`miniprogram-automator@0.12.1` brings legacy transitive dependencies and npm
audit warnings. This archive intentionally pins the known compatible version
instead of running `npm audit fix`, because automatic dependency upgrades could
break WeChat DevTools automation compatibility.

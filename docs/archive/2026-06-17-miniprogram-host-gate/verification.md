# Verification

## Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 317
pass 317
fail 0
```

## Targeted Template Test

命令：

```bash
npm run build
node --test dist/test/miniprogram-templates.test.js
```

结果：

```text
tests 1
pass 1
fail 0
```

## Formatting Guard

命令：

```bash
git diff --check
```

结果：无输出，退出码 0。

## Real MiniProgram Smoke

项目：

```text
/Users/zhongyy40/dev/harness-miniprogram-smoke
```

命令：

```bash
npm run gate
```

结果：

```json
{
  "outcome": "pass",
  "summary": {
    "pass": 1,
    "fail": 0,
    "error": 0,
    "needsReview": 0,
    "total": 1
  },
  "exitCode": 0
}
```

## Root Causes Closed During Real Smoke

1. DevTools CLI 对相对 `--project` 会报 `project.config.json` 无效；插件 managed
   模式传 realpath 绝对路径。
2. `cli auto --port` 是 DevTools HTTP server 端口，不是 automator WebSocket；
   automation WebSocket 使用 `--auto-port`。
3. `cli auto` 返回后 WebSocket 可能还没 ready；runner 模板增加连接重试。
4. 完全清空 managed DevTools CLI env 会导致 DevTools 找不到
   `~/Library/Application Support/微信开发者工具/.../.cli`；插件只 allowlist `HOME`。
5. 任意 ambient secret 仍不会透传给 runner 或 managed DevTools CLI。

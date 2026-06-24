# Verification

## RED

命令：

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

结果：

```text
miniprogram plugin exposes Harness-owned automator dependency to runner
AssertionError: runner should receive NODE_PATH
```

该失败证明旧实现没有给 trusted miniprogram runner 提供稳定的 Harness-owned
automator dependency path。

## GREEN

命令：

```bash
npm run build
node --test dist/test/miniprogram-plugin.test.js
```

结果：

```text
tests 55
pass 55
fail 0
```

新增覆盖：

- runner execution env includes `NODE_PATH`;
- `NODE_PATH` includes a `node_modules` directory that lets CommonJS resolution
  find Harness-owned dependencies.

## Targeted Regression Coverage

命令：

```bash
node --test \
  dist/test/miniprogram-plugin.test.js \
  dist/test/miniprogram-cli.test.js \
  dist/test/miniprogram-templates.test.js
```

结果：

```text
tests 58
pass 58
fail 0
```

覆盖重点：

- miniprogram plugin runner dependency injection;
- CLI still registers and runs miniprogram contracts;
- examples and harness-prep guidance document `NODE_PATH`,
  `miniprogram-automator@0.12.1`, and ESM `createRequire(...)` loading.

## Host/Remote Boundary Coverage

命令：

```bash
node --test \
  dist/test/host-gate.test.js \
  dist/test/remote-gate.test.js \
  dist/test/daytona-environment.test.js
```

结果：

```text
tests 80
pass 80
fail 0
```

覆盖重点：

- host-local miniprogram gates still run on materialized candidate bytes;
- Daytona remote gate and host-local gate aggregation still works;
- miniprogram gate failure feedback and repeated-failure escalation still work.

## Full Suite

命令：

```bash
npm test
```

结果：

```text
tests 578
pass 578
fail 0
```

## CLI Refresh

命令：

```bash
npm run build
npm install -g .
harness --help
```

结果：

```text
npm run build exit 0
npm install -g . exit 0
harness --help exit 0
```

## Formatting

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

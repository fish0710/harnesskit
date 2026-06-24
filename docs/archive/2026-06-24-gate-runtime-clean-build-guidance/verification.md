# Verification

## RED

命令：

```bash
npm run build && node --test dist/test/scaffold.test.js dist/test/miniprogram-templates.test.js dist/test/daytona-gate-snapshot.test.js
```

结果：

```text
tests 14
pass 9
fail 5
```

关键失败：

```text
create writes explicit sandbox trust policy
Expected readOnlyPaths to include docs/reference.

create documents Gate sandbox preflight in AGENTS
Expected AGENTS.md to mention docs/reference/harness-runtime.md.

create writes runtime reference for agent-visible Gate environment facts
ENOENT docs/reference/harness-runtime.md.

miniprogram prep skill documents host-local runner rules
Expected Clean Build Final Task guidance.

harness-prep snapshot guidance documents legacy nvm boundaries
Expected docs/reference/harness-runtime.md guidance.
```

这些失败证明旧实现尚未把 Gate runtime 信息暴露给 Agent，也没有把小程序
clean rebuild 明确建模为 final source-reproducibility task。

## GREEN

命令：

```bash
npm run build && node --test dist/test/scaffold.test.js
```

结果：

```text
tests 5
pass 5
fail 0
```

命令：

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js dist/test/daytona-gate-snapshot.test.js
```

结果：

```text
tests 9
pass 9
fail 0
```

## Targeted Regression Coverage

命令：

```bash
npm run build && node --test \
  dist/test/scaffold.test.js \
  dist/test/sandbox-policy.test.js \
  dist/test/miniprogram-templates.test.js \
  dist/test/daytona-gate-snapshot.test.js
```

结果：

```text
tests 55
pass 55
fail 0
```

覆盖重点：

- scaffold 默认生成 `docs/reference/harness-runtime.md`；
- scaffolded `AGENTS.md` 指向 runtime reference；
- sandbox 默认 `readOnlyPaths` 包含 `docs/reference`；
- harness-prep 小程序指导包含 `Clean Build Final Task`；
- snapshot guidance 明确 Gate has no Claude 和 127.0.0.1 语义。

## Full Suite

普通沙箱中直接运行：

```bash
npm test
```

结果：

```text
tests 579
pass 575
fail 4
```

失败原因均为受限沙箱拒绝本机监听：

```text
listen EPERM: operation not permitted 127.0.0.1
```

按权限规则提升后重跑同一命令：

```bash
npm test
```

结果：

```text
tests 579
pass 579
fail 0
```

## Diff Hygiene

命令：

```bash
git diff --check
```

结果：无输出，表示没有 whitespace 错误。

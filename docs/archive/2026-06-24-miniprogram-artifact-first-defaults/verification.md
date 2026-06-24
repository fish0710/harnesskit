# Verification

## RED

命令：

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

结果：

```text
tests 2
pass 1
fail 1
```

关键失败：

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Artifact-first Default/.
```

该失败证明旧的 harness-prep 小程序指导和 examples 文档还没有固化
artifact-first 默认策略。

## GREEN

命令：

```bash
npm run build && node --test dist/test/miniprogram-templates.test.js
```

结果：

```text
tests 2
pass 2
fail 0
```

覆盖重点：

- harness-prep 小程序指导包含 Artifact-first Default；
- Gate-side rebuilds 被描述为 opt-in source reproducibility checks；
- examples README 说明模板假设 already-built mini-program artifact；
- 文档明确 Harness 不推断框架构建方式。

## Targeted Regression Coverage

命令：

```bash
npm run build && node --test \
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

- miniprogram plugin 行为未被文档变更破坏；
- CLI 仍注册并运行 miniprogram contracts；
- examples 和 harness-prep guidance 均保持 artifact-first 默认语义。

## Final Targeted Verification

提交 `5ff7b44` 后再次运行：

```bash
npm run build && node --test \
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

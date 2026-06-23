# Verification

## Red Regression Check

先把目标测试改为期望 Claude 主命令 `timeoutMs` 为 `undefined`，在旧实现上验证红测。

命令：

```bash
npm run build && node --test dist/test/daytona-environment.test.js
```

结果：

```text
Claude agent setup executes after preflight without using a PTY
actual: 1200000
expected: undefined
exit 1
```

该失败确认旧实现仍把 `20 * 60 * 1000` 传入 Claude 主命令。

## Targeted Regression Suite

实现后重新运行 Daytona environment 测试。

命令：

```bash
npm run build && node --test dist/test/daytona-environment.test.js
```

结果：

```text
tests 32
pass 32
fail 0
exit 0
```

覆盖重点：

- Claude 主命令继续走 `executeCommand` 而不是 PTY；
- preflight 和 agent setup timeout 保持不变；
- Claude 主命令 timeout 变为 `undefined`；
- heartbeat、stream progress、observability snapshot、resume session 等既有 Daytona
  Claude 行为仍通过。

## Full Check

命令：

```bash
npm run check
```

结果：

```text
build exit 0
tests 577
pass 577
fail 0
exit 0
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

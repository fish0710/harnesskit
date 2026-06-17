# Verification

## Full Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 423
pass 423
fail 0
```

## Targeted Claude Environment Regression

命令：

```bash
npm run build
node --test dist/test/daytona-claude.test.js
```

结果：

```text
tests 12
pass 12
fail 0
```

Red/green 过程：

- 新增测试后，旧实现失败并报告缺少
  `ANTHROPIC_MODEL, ANTHROPIC_REASONING_MODEL`；
- 实现 default model fallback 后，目标测试转绿。

## Command Driver Serial Example

临时仓库：

```text
/tmp/harness-serial-example.Xr29OB
```

命令：

```bash
node dist/src/cli.js run --driver command --agent-cmd "sh scripts/agent.sh" --dir contracts
```

结果：

```text
harness series · id=order-refactor-example · tasks=2
[1/2] extract-domain-model
[2/2] split-order-service
✓ series completed
```

产物：

```text
src/domain-model.ts
src/order-service.ts
```

重跑同一命令：

```text
harness series · id=order-refactor-example · tasks=2
✓ series completed
```

该重跑验证 completed task 会由 ledger 直接跳过。

## Real Claude Serial Without Explicit Model Env

临时仓库：

```text
/tmp/harness-claude-serial.bhAIpL
```

命令：

```bash
env -u ANTHROPIC_MODEL -u ANTHROPIC_REASONING_MODEL \
  node dist/src/cli.js run --driver claude --dir contracts
```

结果：

```text
harness series · id=claude-real-serial · tasks=2
[1/2] write-domain-note
[2/2] write-service-note
✓ series completed
```

关键证据：

```text
task1 agent sandbox: 52c426b1-ac84-4f08-9572-a400929f375a
task1 claude session: 8b0b14f2-3aaf-4b8b-a05c-470920017f1e
task2 agent sandbox: f148aa19-11b1-4d19-9253-d3bcdccc3c65
task2 claude session: 58ef8cc1-232f-44e0-ad95-c56a4ccb6294
```

两个 Claude result 均包含 `modelUsage` 和 `total_cost_usd`。

产物：

```text
src/domain-note.txt  -> DomainReady
src/service-note.txt -> ServiceReady
```

## Real Claude Serial With Auto Commit

临时仓库：

```text
/tmp/harness-claude-serial-autocommit.boJzfd
```

命令：

```bash
env -u ANTHROPIC_MODEL -u ANTHROPIC_REASONING_MODEL \
  node dist/src/cli.js run --driver claude --dir contracts
```

配置：

```json
"autoCommit": {
  "enabled": true,
  "messageTemplate": "harness serial: {index}/{total} {id}"
}
```

结果：

```text
harness series · id=claude-real-serial-autocommit · tasks=2
[1/2] write-domain-note
[2/2] write-service-note
✓ series completed
```

Git history：

```text
8743269 claude serial autocommit baseline
b19e9ef harness serial: 1/2 write-domain-note
5f9aa2c harness serial: 2/2 write-service-note
```

Ledger commits：

```text
write-domain-note  -> b19e9ef9b108708a640e44ce6b492ef8b5188125
write-service-note -> 5f9aa2cda4a470a68c24db05a7363cca1f4ccc06
```

最终 git status：

```text
?? .harness/
```

这证明 source 产物已提交，runtime ledger 保持未提交。

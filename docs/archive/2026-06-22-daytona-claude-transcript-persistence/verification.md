# Verification

## Full Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 442
pass 442
fail 0
```

该命令包含：

- TypeScript build；
- full Node test suite；
- Daytona Claude observability unit coverage；
- RunStore attempt `claudeStreamPath` coverage；
- Claude command stream persistence coverage；
- Agent home `.claude` snapshot coverage；
- strong resume coverage。

## Diff Whitespace Check

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

## Targeted Regression Coverage

重点回归测试：

- `test/daytona-claude-resume.test.ts`
  - Claude command 在配置 `HARNESS_CLAUDE_STREAM_PATH` 时写入 mounted stream
    path，并 cat 回 stdout。
- `test/daytona-environment.test.ts`
  - Agent 只挂 run-root observability volume；
  - 不再向 Claude command 注入 `CLAUDE_CONFIG_DIR`；
  - Claude native config dir 记录为 `/home/daytona/.claude`；
  - command 后复制 `$HOME/.claude` 到 `/harness-observability/.claude`；
  - raw stream-json stdout 持久化到
    `/harness-observability/attempt-1/claude-stream.jsonl`。
- `test/observability.test.ts`
  - mounted sandbox path 使用 `/home/daytona/.claude` 作为 native config dir；
  - RunRecorder 在 command start 和 stream event 中记录 `claudeStreamPath`。

## Real Daytona Transcript Evidence

实机排查记录：

- 本地 `claude -p --output-format stream-json --verbose` 会生成完整 native JSONL；
- Daytona 中不直接 mount `$HOME/.claude` 时，native JSONL 包含
  assistant/tool_use/tool_result；
- Daytona volume 直接 mount 到 `/home/daytona/.claude` 时，native JSONL 只剩
  queue/user/attachment 启动事件；
- 修正后的 Harness 真实 run：

```text
runId: 2026-06-18T07-54-53-892Z-d985deb3
agentSandboxId: 27321d13-db02-4258-a7ad-6372c946642e
claudeSessionId: c64bd12f-5842-40ef-95be-ca7a3e7c3556
```

删除 Agent sandbox 后复挂 `runs/<runId>`，确认：

```text
/harness-observability/.claude/projects/-home-daytona-workspace-candidate/c64bd12f-5842-40ef-95be-ca7a3e7c3556.jsonl
assistant=3
tool_use=1
tool_result=1

/harness-observability/attempt-1/claude-stream.jsonl
assistant=3
tool_use=1
tool_result=1
```

## Review Result

归档前做了本地 diff review。未发现需要阻断合入的代码问题。一个非阻断命名点是
`persistClaudeStreamOutput` 现在实际只记录 stream path/bytes 事件，真正写入由
远端 shell command 完成；现有测试覆盖了该行为。

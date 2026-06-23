# Verification

## Full Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 550
pass 550
fail 0
```

覆盖重点：

- TypeScript build；
- full Node test suite；
- command heartbeat helper lifecycle；
- Daytona Claude command heartbeat emission；
- heartbeat interval override validation；
- invalid heartbeat elapsed metadata filtering；
- command settlement 后停止 heartbeat；
- slow final stream read 不会延长 heartbeat；
- RunStore `commandLastHeartbeatAt` 和 `commandLastHeartbeatElapsedMs`；
- harness-prep skill heartbeat supervision 文档快照。

## Targeted Regression Coverage

重点测试文件：

- `test/command-heartbeat.test.ts`
  - pending promise 期间周期性发出 heartbeat；
  - promise resolve/reject 后停止 timer；
  - emitter 异常不会吞掉原 command 结果。
- `test/daytona-environment.test.ts`
  - Daytona Claude command 执行期间发出 `agent.command.heartbeat`；
  - heartbeat 绑定 raw command promise；
  - slow final stream read 期间不会继续报告 command 存活。
- `test/observability.test.ts`
  - RunRecorder 把最新 heartbeat 折叠进 attempt summary；
  - 无效 elapsed metadata 不写入 RunStore。
- `test/daytona-gate-snapshot.test.ts`
  - harness-prep 文档包含 heartbeat supervision；
  - 文档明确 heartbeat 只是 liveness signal，不证明语义进展。

## Plugin Verification

已加入本地 marketplace：

```text
.agents/plugins/marketplace.json
```

安装验证命令：

```bash
codex plugin marketplace add /Users/zhongyy40/workspace/harnesscli/harness
codex plugin add harness-prep@harnesskit
codex plugin list | rg -n "harnesskit|harness-prep"
```

验证结果：

```text
harness-prep@harnesskit installed, enabled 0.1.0+codex.20260622101654
/Users/zhongyy40/workspace/harnesscli/harness/plugins/harness-prep
```

缓存中的 skill 文档已确认包含：

- `agent.command.heartbeat`
- `Heartbeat is a liveness signal only; it does not prove semantic Claude progress.`
- `commandLastHeartbeatAt`
- `commandLastHeartbeatElapsedMs`

## Real Target Project Run

目标项目：

```text
/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab
```

Host gate check：

```bash
node /Users/zhongyy40/workspace/harnesscli/harness/dist/src/cli.js check \
  --dir contracts \
  --config harness.config.json \
  --changed vue3-app/package.json,vue3-app/package-lock.json \
  --json
```

结果：

```text
outcome: pass
contracts: 4/4 pass
```

Gate preflight：

```text
outcome: ready
contracts: 4/4 pass
readinessErrors: []
```

Full run heartbeat evidence：

```text
runId: 2026-06-22T10-24-37-318Z-0d533de0
agentSandboxId: 038cf147-fd09-4fe6-80f3-d991cf8664a9
heartbeat elapsedMs: 30002
heartbeat elapsedMs: 60003
heartbeat elapsedMs: 90004
heartbeat elapsedMs: 120005
commandLastHeartbeatAt: 2026-06-22T10:27:57.864Z
commandLastHeartbeatElapsedMs: 120005
Claude command endedAt: 2026-06-22T10:28:20.275Z
Claude command exitCode: 0
```

该 run 后续为 `escalated`，原因在 command 成功结束后的 candidate collect 阶段：

```text
result: harness.candidate-integrity
status: error
errorReason: Client network socket disconnected before secure TLS connection was established
```

结论：真实项目已验证 heartbeat 能判断 Claude command 仍在运行；剩余失败点是
Daytona/TLS transient error，不属于 heartbeat 功能正确性问题。

## Review Result

归档前完成了 subagent review 和本地回归。一个关键 review 问题已修复：
heartbeat 最初包裹了 `tailClaudeStreamDuring(...)`，可能在 raw Claude command
已经结束但最终 stream read 仍慢时继续发出 heartbeat。最终实现改为 heartbeat
绑定 raw `handle.execute(...)` promise，并把同一个 promise 传给 tailer。

修复后的回归测试覆盖了这个边界：

```text
Claude Daytona command heartbeat stops during slow final stream read
```

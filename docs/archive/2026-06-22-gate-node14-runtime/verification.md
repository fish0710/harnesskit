# Verification

## Local Build And Test

命令：

```bash
npm run build && npm run test
```

结果：

```text
tests 445
pass 445
fail 0
```

覆盖重点：

- Gate release 从 `node-22.14.0-r1` 升为 `node-22.14.0-r2`；
- `harness-gate-runtime-latest` stable name 不变；
- Gate Dockerfile 预装 Node 14.21.3/npm 6.14.18；
- Gate Dockerfile 保持默认 Node 22.14.0；
- Gate image/snapshot preflight 验证 legacy `nvm use`；
- Gate snapshot 继续不包含 `claude`；
- Agent-runtime-to-Gate-latest fallback 发布路径先预装 Node 14；
- harness-prep skill 文档说明 `nvm use`/`nvm install` 边界。

## Diff Whitespace Check

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

## Daytona Snapshot Publish

命令：

```bash
HARNESS_DAYTONA_REPLACE_LATEST=1 npm run snapshot:gate
```

结果：

```text
export HARNESS_DAYTONA_GATE_SNAPSHOT=harness-gate-runtime-latest
```

Snapshot 状态查询：

```text
name=harness-gate-runtime-latest
state=active
```

## Gate Runtime Probe

临时 Gate sandbox 命令：

```bash
bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 14.21.3 >/dev/null && node --version && npm --version && ! command -v claude'
```

结果：

```text
v14.21.3
6.14.18
```

Locale warnings appeared before command output and were not treated as failures.

## Target Project Gate Setup Smoke

目标项目：

```text
/Users/zhongyy40/dev/ztb-consignee-mp-upgrade-lab
```

在 fresh Gate sandbox 上传 `.nvmrc`、`package*.json` 和
`test/gates/run-with-project-node.js` 后执行原始根 setup 命令：

```bash
node test/gates/run-with-project-node.js . --install npm --version
```

结果：

```text
added 2106 packages
6.14.18
exit=0
```

未出现 `/usr/local/nvm/.cache` 或 permission denied。第二条
`vue3-app` setup 在最小上传 smoke 中失败于 npm `ETARGET`，原因是
`@dcloudio/uni-app@3.0.0-4010920250507001` 无匹配版本；这与本次
nvm/Node14 权限缺口无关。

## Harness Smoke Note

执行 no-op command-driver Harness smoke 时，Agent 无修改，Harness 未进入 remote
Gate setup，而是转为 host-local gate 并因业务 gate 失败升级。该 run record 未包含
`/usr/local/nvm/.cache` permission denied，但也不作为本次环境验收依据。

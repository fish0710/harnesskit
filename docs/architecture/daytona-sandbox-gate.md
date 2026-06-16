# Harness Daytona 沙箱门禁架构

> 状态：当前实现
>
> 更新日期：2026-06-16
>
> 适用范围：`harness run --driver claude` 与
> `harness run --driver command`

## 1. 架构目标

Harness 将“执行任务”和“决定是否通过”拆成两个不同权限域：

- agent 在持久化 Daytona 沙箱中修改候选文件；
- 每轮门禁在全新的 Daytona 沙箱中执行；
- 合约、判定、重试、升级和发布始终由宿主进程控制；
- agent 和 gate 沙箱都不能直接产生可信的 `pass`；
- 只有经过门禁验证的精确候选字节可以写回宿主工作区。

核心安全不变量是：

> 沙箱只产生文件和原始执行证据，宿主才拥有决策权。

## 2. 总体架构

![Daytona 沙箱门禁信任边界](../assets/daytona-sandbox-gate/trust-boundary-architecture.png)

图中的关键边界：

- **宿主控制面**是可信域，持有 baseline、合约、`GateCore`、verdict、
  循环预算和 publisher。
- **agent 沙箱**是不可信执行域，允许 Claude Code 或自定义命令修改候选文件。
- **gate 沙箱**是不可信证据采集域，不包含 agent，也不接收模型凭证。
- gate 沙箱只返回退出码、stdout、stderr、耗时或 HTTP 响应等原始证据。
- `GateCore` 在宿主侧把原始证据分类为
  `pass`、`fail`、`error` 或 `needs_review`。

## 3. 组件职责

| 组件 | 所在位置 | 职责 | 信任级别 |
|---|---|---|---|
| CLI 装配 | `src/cli.ts` | 加载配置、合约、插件和 Daytona 环境 | 可信 |
| 循环控制器 | `src/harness/run.ts` | 控制 attempt、反馈、预算、升级和发布 | 可信 |
| Baseline Snapshot | `src/harness/sandbox/workspace.ts` | 从宿主 Git 工作区捕获精确文件字节和元数据 | 可信 |
| Sandbox Policy | `src/harness/sandbox/policy.ts` | 限制候选根、保护路径、文件类型和容量 | 可信 |
| Daytona Adapter | `src/harness/sandbox/daytona.ts` | 创建沙箱、上传下载、PTY、命令执行和清理 | 边界适配 |
| Run Environment | `src/harness/sandbox/environment.ts` | 管理持久 agent 和每轮全新 gate 沙箱 | 可信编排 |
| Candidate Collector | `src/harness/sandbox/workspace.ts` | 下载、校验并生成宿主持有的候选快照 | 可信 |
| Execution Target | `src/harness/execution.ts` | 定义命令和 HTTP 原始证据协议 | 可信协议 |
| GateCore 与插件 | `src/gate.ts`、`src/plugins/*` | 在宿主侧验证证据并聚合结果 | 可信 |
| Publisher | `src/harness/sandbox/publish.ts` | 原子写入门禁实际验证过的精确字节 | 可信 |
| Agent Sandbox | Daytona | 执行 agent 并修改候选工作区 | 不可信 |
| Gate Sandbox | Daytona | 运行合约命令并返回原始证据 | 不可信 |

## 4. 完整执行流程

![Agent 与 Gate 循环](../assets/daytona-sandbox-gate/agent-gate-loop.png)

1. 宿主校验 Daytona、模型环境变量和 sandbox policy。
2. Claude run 要求宿主显式选择 Agent Snapshot。
3. 宿主加载并验证冻结合约，捕获当前 Git 工作区 baseline。
4. Harness 从选定 Snapshot 创建一个 agent 沙箱并上传 agent 可见文件。
5. 宿主执行 Node/npm/npx/Claude preflight 和 agent setup。
6. Claude Code 或 command agent 在该沙箱中执行任务。
7. 宿主通过 Daytona 文件 API 收集候选文件，不信任沙箱内的 Git。
8. 宿主严格校验路径、文件类型、大小、哈希和保护路径。
9. Harness 为当前 attempt 创建一个全新的 gate 沙箱。
10. 宿主在 gate 沙箱中组装 baseline、候选文件和受保护测试资产。
11. gate 沙箱在候选文件和受保护资产都组装完成后执行 `gateSetup`。
12. 若本轮契约不需要 loopback HTTP，gate 沙箱关闭出站网络并执行宿主发出的合约命令。
    若契约访问 `localhost`、`127.0.0.1` 或 `::1`，当前 Daytona
    `networkBlockAll` 会同时阻断 loopback，因此本轮保持网络开启并在 observation 中记录
    `reason=loopback-http`。
13. gate 沙箱把原始证据返回宿主，随后被删除。
14. 宿主 `GateCore` 完成状态分类、聚合和决策。
15. `fail` 或 `error` 生成受限诊断，反馈给原 agent 沙箱继续下一轮。
16. `blocked` 停止自动循环，等待人工 verdict。
17. 超出轮数、时间、token 或重复失败阈值时升级。
18. `pass` 时 publisher 写回门禁验证过的精确候选快照。

agent 沙箱跨重试保留上下文；gate 沙箱每轮重新创建，避免继承 agent 控制的
进程、缓存、凭证或隐藏状态。

## 5. 数据所有权

| 数据 | 产生者 | 使用者 | 是否可信 |
|---|---|---|---|
| Baseline 文件与哈希 | 宿主 | collector、gate assembler、publisher | 是 |
| 合约和冻结哈希 | 宿主 | `GateCore` | 是 |
| 模型凭证 | 宿主进程环境 | 仅 agent PTY | 对 gate 不可见 |
| Agent Snapshot | 宿主进程环境 | 仅 agent sandbox 创建请求 | 对 gate 不可见 |
| Agent stdout、Git、patch 声明 | agent 沙箱 | 仅用于诊断 | 否 |
| Candidate 文件 | agent 沙箱 | 宿主 collector | 收集前否 |
| CandidateSnapshot | 宿主 collector | gate assembler、publisher | 是 |
| 命令退出码与输出 | gate 沙箱 | 宿主插件 | 原始证据 |
| `CheckResult`、`GateReport` | 宿主 | run loop | 是 |
| verdict、retry、escalation | 宿主或人工 | run loop | 是 |

## 6. 门禁不可干预保证

### 6.1 Agent 看不到裁决资产

agent 沙箱不接收：

- contracts；
- verdicts；
- `.harness` 状态；
- gate 选择逻辑；
- 受保护测试；
- CI 配置；
- Harness gate runtime。

### 6.2 Gate 沙箱没有 Agent

gate 沙箱：

- 每轮重新创建；
- 不安装或启动 Claude Code；
- 不接收 Agent Snapshot；
- 不接收 Anthropic 环境变量；
- 不复用 agent 沙箱文件系统；
- 对不依赖 loopback HTTP 的合约，执行期间关闭出站网络；
- 对依赖 loopback HTTP 的合约，当前暂不启用 `networkBlockAll`，因为 Daytona
  远端实现会阻断沙箱访问自身 `127.0.0.1` 服务；
- 完成后删除。

### 6.3 证据不等于判定

gate 沙箱无法返回 `CheckResult` 或 `GateReport`。它只能返回带宿主
`executionId` 的原始证据。以下情况全部 fail closed 为 `error`：

- execution ID 不匹配；
- 退出码、耗时或 HTTP 状态不在合法域；
- 证据缺失或格式错误；
- 命令超时、启动失败或 PTY 中断；
- 沙箱创建、上传、下载、网络隔离或删除失败。

## 7. 候选文件安全

候选收集不使用沙箱内 `git diff`，而是由宿主通过 Daytona API 下载实际字节。

策略层拒绝：

- 绝对路径、`..`、NUL 和不规范路径；
- Windows drive、UNC、ADS、保留设备名和 8.3 别名；
- 大小写或 Unicode 文件系统别名；
- 符号链接和特殊文件；
- 超出候选根的文件；
- 保护路径修改；
- 超出文件数、单文件或总字节限制的候选。

## 8. 发布一致性

publisher 不会在 gate 通过后重新读取 agent 工作区，而是保留并发布被该轮
gate 实际验证的 `CandidateSnapshot`。

发布前会重新验证宿主目标路径仍与 baseline 一致。并发编辑、文件类型变化、
symlink 替换或新增路径冲突都会终止发布。写入使用临时 sibling 和 rename，
多文件失败时执行回滚和临时文件清理。

## 9. 本地 Daytona 与代理

默认控制面地址为：

```text
http://localhost:3000/api
```

Daytona toolbox 使用 `proxy.localhost`。如果宿主设置了
`HTTP_PROXY=http://127.0.0.1:7897`，但未绕过该域名，toolbox 请求会经过代理并
可能返回 502。

SDK adapter 会把以下地址追加到 `NO_PROXY` 和 `no_proxy`：

```text
localhost,127.0.0.1,.localhost,proxy.localhost
```

远端 Daytona 验证时，如果本机 7897 代理已关闭，应显式清理代理变量：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="daytona.wieimmer.asia,localhost,127.0.0.1,proxy.localhost,.localhost"
```

当前实测结论是：Node/Daytona SDK 在清理代理变量后可以访问远端 API；继续保留
已关闭的 7897 代理会导致 TLS tunnel 或 socket hang up 类错误。

Daytona SDK 的文件和进程 API 使用相对 sandbox 路径。adapter 在 SDK 边界把
内部逻辑路径 `/workspace/candidate` 转换为 `workspace/candidate`，并跳过空的
multipart 上传。

## 10. Daytona Runtime Snapshots

Claude Code 不在 run 阶段安装。宿主维护两个稳定 Snapshot 名称：

| 用途 | 默认 Snapshot | 内容 |
|---|---|---|
| Agent | `harness-agent-claude-latest` | Node.js 22.14.0、npm/npx、Claude Code 2.1.145、`/usr/bin/bash` |
| Gate | `harness-gate-runtime-latest` | Node.js 22.14.0、npm/npx、python3、curl、`/usr/bin/bash`；不暴露 `claude` 命令 |

不可变源版本仍保留用于审计：

```text
Node.js 22.14.0
Claude Code 2.1.145
harness-daytona-claude:2.1.145-r2
registry:6000/harness/harness-daytona-claude:2.1.145-r2
harness-agent-claude-2.1.145-r2
```

运行时默认使用 latest。以下环境变量只用于显式覆盖：

```bash
export HARNESS_DAYTONA_AGENT_SNAPSHOT="harness-agent-claude-latest"
export HARNESS_DAYTONA_GATE_SNAPSHOT="harness-gate-runtime-latest"
```

维护命令：

```bash
npm run snapshot:agent
npm run snapshot:gate
npm run snapshot:runtime
```

当前远端发布方式：

1. `snapshot:agent` 从不可变 `harness-agent-claude-2.1.145-r2` 创建临时沙箱，
   通过 preflight 后保存为 `harness-agent-claude-latest`。
2. `snapshot:gate` 从同一个 r2 临时沙箱派生，使用 `sudo rm` 删除
   `/opt/claude-code`、`/usr/local/bin/claude` 和用户级 Claude 配置，验证
   `command -v claude` 失败后保存为 `harness-gate-runtime-latest`。
3. 如果需要替换已有 latest，显式设置
   `HARNESS_DAYTONA_REPLACE_LATEST=1`。脚本会等待旧 Snapshot 删除完成再创建。

Gate Snapshot 只解决机器门禁运行时依赖，不改变信任边界：gate 沙箱仍不注入模型
密钥、Langfuse 密钥或 agent 进程。

HTTP evidence 使用 `HARNESS_HTTP_EVIDENCE ` marker 包裹 JSON 输出。这样即使
Daytona/bash 在 stdout 前写入 locale warning，宿主也只解析 marker 后的证据 JSON。

## 11. 配置模型

```json
{
  "sandbox": {
    "candidateRoots": ["src", "test/generated", "package.json"],
    "protectedPaths": [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
      "test/gates"
    ],
    "agentSetup": [],
    "gateSetup": [
      "npm install",
      "nohup npm start > /tmp/harness-server.log 2>&1 < /dev/null & echo $! > /tmp/harness-server.pid",
      "for i in $(seq 1 50); do node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\" && exit 0; sleep 0.2; done; cat /tmp/harness-server.log; exit 1"
    ],
    "limits": {
      "maxFiles": 10000,
      "maxFileBytes": 10485760,
      "maxTotalBytes": 209715200
    },
    "retainOnFailure": false
  }
}
```

`candidateRoots` 是 allowlist，`protectedPaths` 是额外保护层。新项目由 scaffold
写入显式策略；现有项目缺少配置时使用保守默认值。

`gateSetup` 在 gate 沙箱完成候选覆盖和保护文件恢复后、关闭出站网络前执行。
因此它适合安装 gate 侧依赖、清理测试状态、启动候选 HTTP 服务并轮询 ready。
HTTP 契约中的 `127.0.0.1` 指 gate 沙箱内部服务，不是宿主机器。

HTTP evidence 使用宿主生成的固定脚本采集 `status`、`headers` 和 `body`。
脚本通过 base64 环境变量写入 gate 沙箱临时 `.mjs` 文件再执行，避免 Daytona
`executeCommand` 在长 `node -e` 命令下污染 stdout，导致宿主无法解析 JSON evidence。

## 12. 失败与升级语义

| 门禁结果 | Harness 行为 |
|---|---|
| `pass` | 原子发布精确候选快照并清理 agent 沙箱 |
| `fail` | 生成受限诊断并继续原 agent 沙箱 |
| `error` | 与 fail 一样进入反馈循环，但明确表示基础设施或证据不可信 |
| `blocked` | 停止自动循环，等待人工 review/verdict |
| 预算耗尽 | `stop_for_human` |
| 同一检查重复失败 | `human_review_contract` |
| 上下文达到阈值 | `swap_instance` |

## 13. 已验证状态

2026-06-16 的验证结果：

- Daytona 控制面和 toolbox 可访问；
- Claude Code 从 host 选择的 Agent Snapshot 启动；
- agent 沙箱退出码为 0；
- 独立 gate 沙箱执行合约，结果为 `pass 1/1`；
- 通过后发布精确候选字节；
- `npm run check`：244 个测试全部通过；
- `node --test dist/test/daytona-environment.test.js`：16 个测试全部通过，其中包含
  `gateSetup` 在候选覆盖后执行、loopback HTTP 不启用 `networkBlockAll` 的回归测试；
- 运行结束后无 `harness.role` 残留沙箱；
- API key 只通过进程环境传入，未写入仓库。

## 14. 已知边界

- 模型 token 对 agent 进程可见，设计不保证源码不会发送到已批准模型端点。
- gate 沙箱本身不是可信判定器，只是隔离的证据执行环境。
- 可信测试必须由宿主保护并显式调用；候选可修改的 `npm test` 不能单独作为
  最终裁判。
- `harness check` 和 `harness gate` 仍保留本地执行语义；本架构针对 agent 驱动的
  `run` 循环。
- 当前实现不会自动 merge、push、批准 MR 或绕过 CI。

## 15. 关联资料

- [归档索引](../archive/2026-06-15-daytona-sandbox-gate/README.md)
- [原始设计规格](../superpowers/specs/2026-06-11-daytona-sandbox-gate-design.md)
- [实施计划](../superpowers/plans/2026-06-11-daytona-sandbox-gate.md)
- [本地运行手册](../daytona-local-claude-code-runbook.md)

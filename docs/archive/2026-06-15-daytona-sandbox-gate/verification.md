# 验证记录

## 自动化测试

验证命令：

```bash
npm run check
```

2026-06-15 最终结果：

```text
tests 212
pass 212
fail 0
cancelled 0
skipped 0
todo 0
```

覆盖范围包括：

- 冻结合约哈希和迁移；
- raw evidence 协议及 fail-closed 行为；
- sandbox policy 和跨平台路径别名；
- baseline capture、candidate collection 和 protected paths；
- 多文件事务化发布和并发冲突；
- 持久 agent / 全新 gate 生命周期；
- gate 无模型凭证、无 Claude 安装；
- Daytona SDK 文件、命令、PTY、网络和清理 adapter；
- retry、review、escalation 和 publication 语义。

## 本地 Daytona 集成验证

验证命令：

```bash
npm run test:daytona
```

运行环境：

```text
DAYTONA_API_URL=http://localhost:3000/api
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
NO_PROXY includes proxy.localhost
```

成功输出：

```text
第 1 轮 · environment=daytona(claude)
driver: sandbox agent exited 0
门禁: pass(pass 1/1, fail 0, error 0, review 0)
✓ 就绪:可开 MR
PASS Daytona agent/gate integration
```

该测试实际完成：

1. 创建临时 Git fixture；
2. 创建 agent sandbox；
3. 安装并运行 Claude Code；
4. 修改候选文件；
5. 宿主收集候选字节；
6. 创建独立 gate sandbox；
7. 使用 POSIX `sh` 合约验证精确文件内容；
8. 宿主分类为 pass；
9. 发布精确候选；
10. 删除 agent 和 gate 沙箱。

## 代理问题验证

未绕过 `proxy.localhost` 时，Daytona toolbox 请求会走
`127.0.0.1:7897` 并返回 502。

同时设置以下变量后请求成功：

```text
NO_PROXY=localhost,127.0.0.1,.localhost,proxy.localhost
no_proxy=localhost,127.0.0.1,.localhost,proxy.localhost
```

生产 adapter 会自动追加这些地址。

## 清理验证

通过 Daytona SDK 枚举带 `harness.role` label 的沙箱，结果：

```json
[]
```

说明最终验证结束后没有残留 agent 或 gate 沙箱。

## 凭证处理

- Daytona API key 仅通过命令进程环境传入；
- Anthropic token 仅注入 agent PTY；
- gate sandbox 不接收模型凭证；
- 文档和源码中未写入真实 key；
- 日志和归档只保留变量名与脱敏配置。

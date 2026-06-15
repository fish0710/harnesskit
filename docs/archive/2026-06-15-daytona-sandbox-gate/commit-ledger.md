# 实现提交账本

提交范围：`main..codex/daytona-sandbox-gate`

| 提交 | 日期 | 内容 |
|---|---|---|
| `55f4e9e` | 2026-06-11 | 修复嵌套冻结合约字段哈希 |
| `6efdf6f` | 2026-06-12 | 保留特殊合约键 |
| `59074fb` | 2026-06-12 | 引入版本化冻结哈希 |
| `cfc4016` | 2026-06-12 | 准确报告旧哈希迁移 |
| `c6b711e` | 2026-06-12 | 在宿主分类远程 gate 证据 |
| `e6de2ac` | 2026-06-12 | 不完整证据 fail closed |
| `197fc99` | 2026-06-12 | 校验证据值域 |
| `847c340` | 2026-06-12 | 校验证据耗时 |
| `95cc35e` | 2026-06-12 | 定义 sandbox candidate policy |
| `b5bf576` | 2026-06-12 | 加固路径别名策略 |
| `463c1ad` | 2026-06-12 | 匹配宿主文件系统语义 |
| `6a7ce47` | 2026-06-12 | 保持候选 allowlist 与卷无关 |
| `2c30b08` | 2026-06-12 | 拒绝跨平台路径别名 |
| `5945104` | 2026-06-12 | 拒绝 NTFS 8.3 别名 |
| `9927398` | 2026-06-12 | 拒绝非法 Unicode 路径 |
| `9d45d15` | 2026-06-12 | 收集并发布宿主持有候选 |
| `9eff2da` | 2026-06-12 | 候选发布事务化 |
| `d74aa7e` | 2026-06-12 | 增加可注入 Daytona adapter |
| `c0b2cf6` | 2026-06-12 | 在 Daytona 环境运行 agent 和 gate |
| `1f70611` | 2026-06-12 | mutating agent 默认使用 Daytona |
| `b9af03f` | 2026-06-12 | 发布运行手册和显式策略 |
| `bc8a37c` | 2026-06-12 | 覆盖最终信任边界测试 |
| `0b26b61` | 2026-06-15 | 关闭最终沙箱信任缺口 |
| `eb3b63b` | 2026-06-15 | 兼容本地 Daytona SDK 实际执行 |

## 变更规模

相对 `main`：

- 37 个文件发生变化；
- 新增约 9,235 行；
- 删除约 178 行；
- 新增 Daytona adapter、sandbox policy、candidate collector、
  transactional publisher、host execution evidence 和完整测试覆盖。

## 关键修复链

### 冻结合约

递归 canonical JSON、特殊键保护和版本化哈希共同保证嵌套合约修改不能沿用旧
冻结结果。

### 宿主裁决

插件不再直接信任执行环境返回的状态，而是使用宿主生成的 execution ID 和严格
证据协议分类结果。

### 候选隔离

候选文件由宿主通过 Daytona 文件 API 收集，不使用 agent 可控制的 Git 元数据。

### 发布一致性

发布前进行 baseline preflight，采用临时 sibling、rename 和回滚，保证写回的是
门禁实际验证的字节。

### 本地 Daytona 兼容

最终提交处理：

- `proxy.localhost` 的 `NO_PROXY` 绕过；
- Daytona SDK 相对路径要求；
- 空 multipart 上传；
- Claude 安装命令超时；
- PTY timeout/abort 无法结束等待；
- 基础 gate 镜像中不假设存在 Node.js。

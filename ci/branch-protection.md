# 合入门:平台侧一次性设置(GitHub 为例)

目标:**合入裁决发生在 agent 够不到的隔离环境**;agent 只能 push / 开 MR,不能合并、不能绕过。

## GitHub 分支保护(Settings → Branches → 对 `main` 加规则)

- [x] Require a pull request before merging
- [x] Require status checks to pass → 勾选 **`gate`**(harness-gate.yml 的 job)
- [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings(管理员也不例外)
- [x] 关闭对 `main` 的直接 push(人和 agent 都不能直推)
- [x] (可选,高保证)Require signed commits / 配合 SLSA attestation

## CODEOWNERS(见 ci/CODEOWNERS.example)

锁定 `contracts/`、`contracts/frozen/`、`harness.config.json`、`.github/workflows/`:
改这些的 PR **强制指定审批人**。这堵住四条作弊路径中的两条——
"改判分契约" 与 "改门禁选择/映射"(改契约/改映射 = 改规则,必须人审)。

## 四样必须在 agent 够不到处(对应 §9)

1. 判分契约 + 标准答案 → 锁 `contracts/frozen/`(CODEOWNERS) 或独立鉴权存储
2. "跑哪些门禁/哪版契约"的解析与映射 → 锁 `harness.config.json`,CI 侧解析改动
3. 判定发生的环境 → CI 干净检出重建,不复用沙箱
4. 取数据的鉴权凭证 → 由平台/worker 持有,不下发给 agent

## GitLab 等价

Protected branches + `rules:` pipeline + Merge request approvals + CODEOWNERS,语义相同。

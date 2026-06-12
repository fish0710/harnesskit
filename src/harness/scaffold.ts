import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface FileSpec {
  path: string;
  content: string;
}

/** 项目骨架文件。create 会生成这些(已存在的默认跳过,除非 force)。 */
function projectFiles(): FileSpec[] {
  return [
    {
      path: "AGENTS.md",
      content: `# AGENTS.md — 代码库地图

> 地图,不是规则书(≤100 行)。细节在 docs/。

## 工作循环
读意图(docs/specs, docs/plans) → 改代码 → 跑 \`harness check\` 拿反馈 → 修到全绿 → 才算完成。
你只能 push / 开 MR,不能合并;冻结契约(contracts/frozen/)不可改。

## 结构
- contracts/         行为契约(判据,数据)。contracts/frozen/ 为冻结裁判,CODEOWNERS 锁。
- docs/decisions/    架构决策(每条规则的 why)
- docs/specs/        需求规格
- docs/plans/        执行计划(harness plan 生成)
- harness.config.json 门禁选择映射(CODEOWNERS 锁)

## 不可违反
查行为不查工件 · 满足契约才算完成 · 不改冻结契约(改契约=改规则,走人审)。
`,
    },
    {
      path: "harness.config.json",
      content: JSON.stringify(
        {
          baseline: ["smoke.boot"],
          rules: [{ when: ["src/**"], select: [] }],
          sandbox: {
            candidateRoots: [
              "src",
              "test/generated",
              "package.json",
              "package-lock.json",
              "tsconfig.json",
            ],
            protectedPaths: [
              "contracts",
              ".harness",
              "harness.config.json",
              ".github/workflows",
              "CODEOWNERS",
              "test/gates",
            ],
            agentSetup: [],
            gateSetup: [],
            limits: {
              maxFiles: 10_000,
              maxFileBytes: 10 * 1024 * 1024,
              maxTotalBytes: 200 * 1024 * 1024,
            },
            retainOnFailure: false,
          },
        },
        null,
        2,
      ),
    },
    {
      path: "contracts/smoke.boot.yaml",
      content: `id: smoke.boot
type: boot
scenario: 服务应在 800ms 内启动(把 cmd 换成你的启动命令)
cmd: "true"
expect:
  startup_ms_lte: 800
`,
    },
    {
      path: "contracts/example.http.yaml",
      content: `id: example.endpoint
type: http
scenario: 示例接口契约(把 baseUrl 指向你的服务)
trigger:
  method: GET
  baseUrl: "http://127.0.0.1:8080"
  path: /health
expect:
  status: 200
`,
    },
    {
      path: "docs/decisions/0001-layered-architecture.md",
      content: `# ADR 0001:分层架构\n\n状态:草案。在此记录你的分层与依赖方向(每条规则的 why)。\n`,
    },
    { path: "docs/specs/.gitkeep", content: "" },
    { path: "docs/plans/.gitkeep", content: "" },
    {
      path: "docs/reference/principles.md",
      content: `# 核心原则(被 structure 契约机械检查)\n\n在此登记可机械检查的原则,并在 contracts/ 里加对应 structure 契约。\n`,
    },
    {
      path: "CODEOWNERS",
      content: `# 锁定判据与门禁选择:改它们的 PR 强制审批(改契约=改规则)
/contracts/frozen/    @your-org/spec-team
/harness.config.json  @your-org/platform
/.github/workflows/   @your-org/platform
`,
    },
    {
      path: ".github/workflows/harness-gate.yml",
      content: `name: harness-gate
on:
  pull_request:
    branches: [ main ]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4      # 干净检出,不复用 agent 沙箱
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npx harness meta  --dir contracts    # 先验门禁自己没瞎
      - run: npx harness check --dir contracts --config harness.config.json
`,
    },
    { path: ".harness/.gitkeep", content: "" },
  ];
}

export interface CreateResult {
  created: string[];
  skipped: string[];
}

export function createProject(targetDir: string, force = false): CreateResult {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of projectFiles()) {
    const full = join(targetDir, f.path);
    if (existsSync(full) && !force) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, f.content, "utf8");
    created.push(f.path);
  }
  return { created, skipped };
}

#!/usr/bin/env node
/**
 * harness CLI —— UI 层。职责:加载契约、选取、调 GateCore、渲染、定退出码。
 * 它不做任何业务判定(判定在插件/引擎)。主要使用者是 agent(--json)与人(pretty)。
 *
 * 子命令:
 *   check    [--dir d] [--changed a,b | --stage s] [--config f] [--base-url u] [--properties m] [--json]
 *   gate <stage>  [--dir d] [...]              # = check --stage <stage>
 *   meta     [--dir d] [--properties m] [--json]  # 用 examples 标定插件(先验门禁自己没瞎)
 *   explain <contractId> [--dir d]             # 打印某契约的 scenario/type/决策重点
 *   contract validate <dir>                    # 只校验契约规格
 *   contract freeze <file>                     # 冻结契约(打 hash,写回)
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";

import { GateCore } from "./gate.js";
import { commandPlugin } from "./plugins/command.js";
import { bootPlugin } from "./plugins/boot.js";
import { reviewPlugin } from "./plugins/review.js";
import { httpPlugin } from "./plugins/http.js";
import { structurePlugin } from "./plugins/structure.js";
import { miniprogramPlugin } from "./plugins/miniprogram.js";
import { createInvariantPlugin, type Property } from "./plugins/invariant.js";
import { renderPretty, renderJson } from "./reporter.js";
import { loadContracts, freezeContract, verifyFrozen, validateContract } from "./contracts.js";
import { selectByChange, selectByStage, type SelectConfig } from "./selector.js";
import type { Contract, RunContext } from "./types.js";

import {
  scaffoldDriver,
  selectAgent,
  type AgentSpec,
} from "./harness/drivers.js";
import {
  localRunEnvironment,
  runLoop,
  type GenerationBudget,
  type RunEnvironment,
} from "./harness/run.js";
import { createDaytonaSdkProvider } from "./harness/sandbox/daytona.js";
import { createDaytonaRunEnvironment } from "./harness/sandbox/environment.js";
import { loadSandboxPolicy } from "./harness/sandbox/policy.js";
import { loadVerdicts, recordVerdict } from "./harness/verdicts.js";
import { writeRunRecord, type RunRecord } from "./harness/record.js";
import { createProject } from "./harness/scaffold.js";
import { writePlan } from "./harness/plan.js";
import { gatherStatus } from "./harness/status.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const rest = argv.slice(1);

const OPTIONS = {
  dir: { type: "string" as const, default: "contracts" },
  json: { type: "boolean" as const, default: false },
  changed: { type: "string" as const },
  stage: { type: "string" as const },
  config: { type: "string" as const },
  "base-url": { type: "string" as const },
  properties: { type: "string" as const },
  // 产出引擎
  driver: { type: "string" as const, default: "scaffold" },
  "agent-cmd": { type: "string" as const },
  "max-attempts": { type: "string" as const },
  force: { type: "boolean" as const, default: false },
  // review --resolve
  resolve: { type: "string" as const },
  option: { type: "string" as const },
  by: { type: "string" as const },
  reason: { type: "string" as const },
};

function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: OPTIONS });
}

/** 可选地从模块加载属性函数表(invariant 插件用)。 */
async function loadProperties(modPath?: string): Promise<Record<string, Property>> {
  if (!modPath) return {};
  const url = pathToFileURL(resolve(process.cwd(), modPath)).href;
  const mod = (await import(url)) as { properties?: Record<string, Property>; default?: Record<string, Property> };
  return mod.properties ?? mod.default ?? {};
}

/** 装配带全部内置插件的 GateCore。 */
async function buildGate(propertiesPath?: string): Promise<GateCore> {
  const gate = new GateCore()
    .use(commandPlugin)
    .use(bootPlugin)
    .use(reviewPlugin)
    .use(httpPlugin)
    .use(structurePlugin)
    .use(miniprogramPlugin);
  const properties = await loadProperties(propertiesPath);
  if (Object.keys(properties).length > 0) gate.use(createInvariantPlugin(properties));
  return gate;
}

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

const SECRET_OBSERVATION_KEY =
  /(?:api[_-]?key|key|token|secret|password|authorization|auth|cookie)/i;

function isSecretObservationKey(key: string): boolean {
  return SECRET_OBSERVATION_KEY.test(key);
}

export function redactObservationData(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return "[unserializable]";
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactObservationData(item, seen));
  }

  const output: Record<string, unknown> = {};
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value);
  } catch {
    return "[unserializable]";
  }
  for (const [key, item] of entries) {
    output[key] = isSecretObservationKey(key)
      ? "[redacted]"
      : redactObservationData(item, seen);
  }
  return output;
}

async function cmdCheck(args: string[]): Promise<void> {
  const { values } = parse(args);
  const dir = resolve(process.cwd(), values.dir as string);

  // 1) 加载契约;规格本身有问题 → error(无法验证契约 ⇒ 不放行)
  const { contracts, issues } = loadContracts(dir);
  if (issues.length) {
    console.error("✗ 契约规格存在问题(视为 error,不放行):");
    for (const i of issues) console.error(`  - ${i.file ?? ""} ${i.contractId ?? ""}: ${i.message}`);
    process.exit(1);
  }

  // 2) 冻结契约校验
  const verificationFailures = contracts.map(verifyFrozen).filter((r) => !r.ok);
  if (verificationFailures.length) {
    console.error("✗ 冻结契约校验失败(视为 error,不放行):");
    for (const failure of verificationFailures) console.error(`  - ${failure.message}`);
    process.exit(1);
  }

  // 3) 选取:--changed + --config → 按改动;--stage → 按阶段;否则全选
  let selected: Contract[] = contracts;
  if (values.stage) {
    selected = selectByStage(contracts, values.stage as string);
  } else if (values.changed) {
    const changedFiles = (values.changed as string).split(",").map((s) => s.trim()).filter(Boolean);
    let config: SelectConfig = { baseline: contracts.map((c) => c.id), rules: [] }; // 缺省:全恒选
    if (values.config) {
      config = JSON.parse(readFileSync(resolve(process.cwd(), values.config as string), "utf8")) as SelectConfig;
    }
    selected = selectByChange(contracts, config, changedFiles).selected;
  }

  // 4) 跑门禁
  const gate = await buildGate(values.properties as string | undefined);
  const ctx: RunContext = { cwd: process.cwd(), verdicts: loadVerdicts(process.cwd()) };
  if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl = values["base-url"] as string;
  const report = await gate.run(selected, ctx);

  console.log(values.json ? renderJson(report) : renderPretty(report));
  process.exitCode = report.exitCode; // 0 pass / 1 fail(含 error) / 2 blocked
}

async function cmdGate(args: string[]): Promise<void> {
  const stage = args[0];
  if (!stage) fail("用法: harness gate <stage>");
  await cmdCheck(["--stage", stage, ...args.slice(1)]);
}

async function cmdMeta(args: string[]): Promise<void> {
  const { values } = parse(args);
  const dir = resolve(process.cwd(), values.dir as string);
  const { contracts, issues } = loadContracts(dir);
  if (issues.length) fail("契约规格有问题,先修复再 meta");
  const gate = await buildGate(values.properties as string | undefined);
  const { ok, lines } = await gate.calibrate(contracts);
  if (values.json) {
    console.log(JSON.stringify({ ok, lines }, null, 2));
  } else {
    console.log(lines.length ? lines.join("\n") : "(没有可 selfCalibrate 的契约)");
    console.log(ok ? "\n✓ 元测试通过:门禁自己没瞎" : "\n✗ 元测试失败:有插件未通过 examples 标定");
  }
  process.exitCode = ok ? 0 : 1;
}

function cmdExplain(args: string[]): void {
  const { values, positionals } = parse(args);
  const id = positionals[0];
  if (!id) fail("用法: harness explain <contractId>");
  const dir = resolve(process.cwd(), values.dir as string);
  const { contracts } = loadContracts(dir);
  const c = contracts.find((x) => x.id === id);
  if (!c) fail(`未找到契约: ${id}`);
  console.log(`契约 ${c!.id}`);
  console.log(`  type:     ${c!.type}`);
  console.log(`  scenario: ${c!.scenario ?? "(无)"}`);
  if (c!.owner) console.log(`  owner:    ${c!.owner}`);
  if (c!.frozen) console.log(`  frozen:   是 (hash ${c!.hash}, at ${c!.frozen_at})`);
  if (Array.isArray(c!.focalPoints)) {
    console.log("  决策重点:");
    for (const fp of c!.focalPoints as string[]) console.log(`    • ${fp}`);
  }
  if (typeof c!.ref === "string") console.log(`  参见:     ${c!.ref}`);
}

function cmdContract(args: string[]): void {
  const sub = args[0];
  const target = args[1];
  if (sub === "validate") {
    if (!target) fail("用法: harness contract validate <dir>");
    const { issues } = loadContracts(resolve(process.cwd(), target));
    if (issues.length === 0) {
      console.log("✓ 所有契约规格校验通过");
      return;
    }
    for (const i of issues) console.error(`  - ${i.file ?? ""} ${i.contractId ?? ""}: ${i.message}`);
    process.exit(1);
  }
  if (sub === "freeze") {
    if (!target) fail("用法: harness contract freeze <file>");
    const file = resolve(process.cwd(), target);
    const text = readFileSync(file, "utf8");
    const ext = extname(file).toLowerCase();
    const parsed: unknown = ext === ".json" ? JSON.parse(text) : yaml.load(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const v = validateContract(item, file);
      if (v.length) fail(`契约规格无效,无法冻结: ${v.map((x) => x.message).join("; ")}`);
    }
    const frozen = items.map((i) => freezeContract(i as Contract));
    const out = Array.isArray(parsed) ? frozen : frozen[0];
    writeFileSync(file, ext === ".json" ? JSON.stringify(out, null, 2) : yaml.dump(out), "utf8");
    console.log(`✓ 已冻结 ${target}（打上 frozen/hash）`);
    return;
  }
  fail("用法: harness contract <validate|freeze> ...");
}

// ---------- 产出引擎命令 ----------

function buildBudget(values: Record<string, unknown>, agent: AgentSpec): GenerationBudget {
  const def = agent.kind === "scaffold" ? 1 : 5;
  const maxAttempts = values["max-attempts"] ? Number(values["max-attempts"]) : def;
  return { maxAttempts, maxTokens: 1e9, maxMs: 600_000, contextThreshold: 0.9, repeatWallThreshold: 3 };
}

function loadHarnessConfig(
  cwd: string,
  configuredPath: string | undefined,
): unknown {
  const path = configuredPath
    ? resolve(cwd, configuredPath)
    : resolve(cwd, "harness.config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function doRun(args: string[], task: string, initialFeedback?: string): Promise<void> {
  const { values } = parse(args);
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);

  const { contracts, issues } = loadContracts(dir);
  if (issues.length) { for (const i of issues) console.error(`  - ${i.message}`); fail("契约规格有问题,先修复"); }
  const verificationFailures = contracts.map(verifyFrozen).filter((r) => !r.ok);
  if (verificationFailures.length) {
    for (const failure of verificationFailures) console.error(`  - ${failure.message}`);
    fail("冻结契约校验失败");
  }

  const selected = values.stage ? selectByStage(contracts, values.stage as string) : contracts;
  const gate = await buildGate(values.properties as string | undefined);
  const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
  if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl = values["base-url"] as string;

  let agent: AgentSpec;
  try {
    agent = selectAgent(values);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const config = loadHarnessConfig(
    cwd,
    values.config as string | undefined,
  );
  const policy = loadSandboxPolicy(config);
  let environment: RunEnvironment;
  if (agent.kind === "scaffold") {
    environment = localRunEnvironment(scaffoldDriver, cwd);
  } else {
    environment = createDaytonaRunEnvironment({
      provider: createDaytonaSdkProvider(process.env),
      root: cwd,
      policy,
      agent,
      environment: process.env,
      onObservation(event, data) {
        console.log(
          `    · ${event}: ${JSON.stringify(redactObservationData(data))}`,
        );
      },
    });
  }
  const budget = buildBudget(values, agent);

  console.log(
    `harness run · task="${task}" · environment=${environment.name}` +
    ` · 契约 ${selected.length} 条`,
  );
  console.log(
    `sandbox roots=[${policy.candidateRoots.join(", ")}]` +
    ` protected=[${policy.protectedPaths.join(", ")}]\n`,
  );
  const outcome = await runLoop({
    task, contracts: selected, gate, ctx,
    environment, budget,
    ...(initialFeedback ? { initialFeedback } : {}),
    onLog: (l) => console.log(l),
  });

  const rec: RunRecord = {
    at: new Date().toISOString(), task, driver: environment.name,
    outcome: outcome.outcome, attempts: outcome.attempts, summary: outcome.report.summary,
    ...(outcome.action ? { action: outcome.action } : {}),
  };
  const recPath = writeRunRecord(cwd, rec);

  console.log("");
  if (outcome.outcome === "ready_for_mr") {
    console.log("✓ 就绪:可开 MR(绿不算放行,合入裁决在 CI)。");
  } else if (outcome.outcome === "blocked") {
    console.log("◐ 有待人工决策:运行 `harness review` 查看决策重点并裁决,再重跑。");
  } else {
    console.log(`■ 已升级:${outcome.action?.kind} — ${outcome.action?.reason}`);
    if (agent.kind === "scaffold") {
      console.log("  (这是 scaffold 空跑 driver:未产出代码。换 --driver claude 或 --driver command 接真实 agent 即可据上面门禁反馈迭代修复。)");
    }
  }
  console.log(`运行记录: ${recPath}`);
  process.exitCode = outcome.outcome === "ready_for_mr" ? 0 : outcome.outcome === "blocked" ? 2 : 1;
}

async function cmdRun(args: string[]): Promise<void> {
  const { positionals } = parse(args);
  const task = positionals[0];
  if (!task) fail('用法: harness run "<task 描述>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s]');
  await doRun(args, task!);
}

async function cmdFix(args: string[]): Promise<void> {
  await doRun(args, "运行门禁并根据隔离环境反馈修复未通过项");
}

async function cmdReview(args: string[]): Promise<void> {
  const { values } = parse(args);
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);
  const { contracts } = loadContracts(dir);

  // 裁决模式
  if (values.resolve) {
    const id = values.resolve as string;
    const optionId = values.option as string | undefined;
    const by = (values.by as string) ?? "unknown";
    if (!optionId) fail("用法: harness review --resolve <契约id> --option <选项id> --by <你> [--reason ...]");
    const c = contracts.find((x) => x.id === id);
    if (!c) fail(`未找到契约: ${id}`);
    const opts = Array.isArray(c!.options) ? (c!.options as Array<{ id: string }>) : [];
    if (opts.length && !opts.find((o) => o.id === optionId)) {
      fail(`选项 "${optionId}" 不在该契约的可选裁决里: [${opts.map((o) => o.id).join(", ")}]`);
    }
    recordVerdict(cwd, id, { optionId: optionId!, by, at: new Date().toISOString(), ...(values.reason ? { reason: values.reason as string } : {}) });
    console.log(`✓ 已记录裁决: ${id} → ${optionId}(by ${by})。重跑 \`harness check\` / \`harness gate\` 即解析。`);
    return;
  }

  // 列表模式:跑门禁,列出仍待决策项的决策重点
  const gate = await buildGate(values.properties as string | undefined);
  const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
  if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl = values["base-url"] as string;
  const report = await gate.run(contracts, ctx);
  if (report.pendingDecisions.length === 0) {
    console.log("✓ 没有待人工决策项。");
    return;
  }
  console.log(`待人工决策 ${report.pendingDecisions.length} 项:\n`);
  for (const r of report.pendingDecisions) {
    const d = r.decision!;
    console.log(`◐ ${r.id}`);
    console.log(`  决定: ${d.question}`);
    if (d.focalPoints.length) { console.log("  决策重点:"); for (const fp of d.focalPoints) console.log(`    • ${fp}`); }
    if (d.evidence.length) { console.log("  证据:"); for (const e of d.evidence) console.log(`    - ${e.label}: ${e.value}`); }
    console.log("  可选裁决:");
    for (const o of d.options) console.log(`    [${o.id}] ${o.label} ${o.resolvesTo === "pass" ? "→放行" : "→挡回"}${d.recommended === o.id ? " (建议)" : ""}`);
    console.log(`  裁决: harness review --resolve ${r.id} --option <id> --by <你> --reason "..."`);
    console.log("");
  }
}

function cmdStatus(args: string[]): void {
  const { values } = parse(args);
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);
  console.log(gatherStatus(cwd, dir).join("\n"));
}

function cmdCreate(args: string[]): void {
  const { values, positionals } = parse(args);
  const target = resolve(process.cwd(), positionals[0] ?? ".");
  const { created, skipped } = createProject(target, values.force as boolean);
  console.log(`✓ 初始化 harness 项目于 ${target}`);
  if (created.length) console.log("  新建: " + created.join(", "));
  if (skipped.length) console.log("  跳过(已存在,--force 覆盖): " + skipped.join(", "));
  console.log("\n下一步: 编辑 contracts/ 写真实契约 → harness check → 配 CODEOWNERS/分支保护 → harness run \"<task>\"");
}

function cmdPlan(args: string[]): void {
  const { positionals } = parse(args);
  const task = positionals[0];
  if (!task) fail('用法: harness plan "<task 描述>"');
  const path = writePlan(process.cwd(), task!);
  console.log(`✓ 已生成计划模板: ${path}\n  (意图层产物;AI 可协助起草,验收契约由评估器侧定稿并冻结)`);
}

function help(): void {
  console.log(`harness — 完整门禁 + 产出引擎 CLI

产出引擎(可跑通;真实代码产出靠 --driver):
  harness create [dir] [--force]                # 初始化项目骨架(AGENTS.md/docs/contracts/CI/CODEOWNERS)
  harness plan "<task>"                          # 生成执行计划 Plan.md(模板)
  harness run  "<task>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s] [--max-attempts n]
  harness fix  [--driver ...] [--stage s]        # 先取门禁诊断,再驱动 driver 修复迭代
  harness review [--resolve <id> --option <o> --by <name> [--reason ...]]   # 汇总/记录人工决策
  harness status                                 # 项目状态(契约/冻结/裁决/最近 run)

门禁(验证层):
  harness check [--dir d] [--changed a,b | --stage s] [--config f] [--base-url u] [--properties m] [--json]
  harness gate <stage> [...]                     # = check --stage <stage>
  harness meta  [--dir d] [--properties m]        # 用 examples 标定插件(先验门禁自己没瞎)
  harness explain <contractId>
  harness contract validate <dir> | freeze <file>

driver 说明:scaffold=默认空跑(看链路,不产出代码);command=跑你的 agent 脚本(--agent-cmd);claude=Agent SDK(需装 SDK+API key)。
退出码: 0=通过/就绪 · 1=失败或已升级 · 2=待人工决策(blocked)`);
}

async function main(): Promise<void> {
  switch (command) {
    case "create": cmdCreate(rest); break;
    case "plan": cmdPlan(rest); break;
    case "run": await cmdRun(rest); break;
    case "fix": await cmdFix(rest); break;
    case "review": await cmdReview(rest); break;
    case "status": cmdStatus(rest); break;
    case "check": await cmdCheck(rest); break;
    case "gate": await cmdGate(rest); break;
    case "meta": await cmdMeta(rest); break;
    case "explain": cmdExplain(rest); break;
    case "contract": cmdContract(rest); break;
    case "help": case "--help": case "-h": help(); break;
    default: console.error(`未知命令: ${command}\n`); help(); process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

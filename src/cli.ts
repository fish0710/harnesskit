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
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
} from "./harness/drivers.js";
import { buildGenerationBudget } from "./harness/budget.js";
import {
  localRunEnvironment,
  runLoop,
  type RunOutcome,
  type RunEnvironment,
} from "./harness/run.js";
import {
  loadTaskSeriesConfig,
  readSeriesLedger,
  runTaskSeries,
  type TaskSeriesConfig,
} from "./harness/series.js";
import {
  buildRunId,
  claudeObservabilityPaths,
  DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
  loadDaytonaObservabilityConfig,
  type DaytonaObservabilityConfig,
} from "./harness/observability.js";
import { createDaytonaSdkProvider } from "./harness/sandbox/daytona.js";
import { createDaytonaRunEnvironment } from "./harness/sandbox/environment.js";
import { loadSandboxPolicy } from "./harness/sandbox/policy.js";
import { loadVerdicts, recordVerdict } from "./harness/verdicts.js";
import {
  RunStore,
  type RunRecordChild,
  type RunRecordObservability,
} from "./harness/record.js";
import { createProject } from "./harness/scaffold.js";
import { writePlan } from "./harness/plan.js";
import { gatherStatus } from "./harness/status.js";
import { isHostLocalContract } from "./harness/host-gate.js";
import { redactObservationData } from "./harness/redaction.js";
import {
  gatePreflightRunBlocker,
  lintGateReadiness,
  renderGatePreflightJson,
  renderGatePreflightPretty,
  runGatePreflight,
  type GatePreflightReport,
} from "./harness/preflight.js";
import type {
  SandboxPolicy,
  SandboxProvider,
} from "./harness/sandbox/types.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const rest = argv.slice(1);

export { redactObservationData } from "./harness/redaction.js";

const OPTIONS = {
  dir: { type: "string" as const, default: "contracts" },
  json: { type: "boolean" as const, default: false },
  changed: { type: "string" as const },
  stage: { type: "string" as const },
  config: { type: "string" as const },
  "base-url": { type: "string" as const },
  properties: { type: "string" as const },
  "retain-on-failure": { type: "boolean" as const, default: false },
  "task-id": { type: "string" as const },
  "series-id": { type: "string" as const },
  // 产出引擎
  driver: { type: "string" as const, default: "scaffold" },
  "agent-cmd": { type: "string" as const },
  "max-attempts": { type: "string" as const },
  "max-ms": { type: "string" as const },
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

function createLazyDaytonaProvider(environment: NodeJS.ProcessEnv): SandboxProvider {
  return {
    create(request) {
      return createDaytonaSdkProvider(environment).create(request);
    },
  };
}

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function selectContractsForValues(
  contracts: Contract[],
  values: Record<string, unknown>,
  cwd = process.cwd(),
): Contract[] {
  if (values.stage) {
    return selectByStage(contracts, values.stage as string);
  }
  if (values.changed) {
    const changedFiles = (values.changed as string).split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let config: SelectConfig = { baseline: contracts.map((c) => c.id), rules: [] };
    if (values.config) {
      config = JSON.parse(
        readFileSync(resolve(cwd, values.config as string), "utf8"),
      ) as SelectConfig;
    }
    return selectByChange(contracts, config, changedFiles).selected;
  }
  return contracts;
}

function staticGatePreflightReport(
  contracts: Contract[],
  policy: SandboxPolicy,
  ctx: RunContext,
): GatePreflightReport {
  const baseUrl = (ctx as { baseUrl?: string }).baseUrl;
  const staticFindings = lintGateReadiness({ contracts, policy, baseUrl });
  const staticErrors = staticFindings.filter((finding) =>
    finding.severity === "error"
  );
  const remoteContracts = contracts.filter((contract) =>
    !isHostLocalContract(contract)
  );
  const hostLocalContracts = contracts.filter(isHostLocalContract);
  return {
    outcome: staticErrors.length > 0 ? "not_ready" : "ready",
    staticFindings,
    setup: [],
    selectedContracts: contracts.map((contract) => contract.id),
    remoteContracts: remoteContracts.map((contract) => contract.id),
    hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
    readinessErrors: staticErrors,
    productFailures: [],
  };
}

function preflightEventSummary(
  report: GatePreflightReport,
): Record<string, unknown> {
  return {
    outcome: report.outcome,
    selectedContracts: report.selectedContracts,
    remoteContracts: report.remoteContracts,
    hostLocalContracts: report.hostLocalContracts,
    readinessErrors: report.readinessErrors.map((finding) => finding.id),
    productFailures: report.productFailures,
    ...(report.sandbox ? { sandbox: report.sandbox } : {}),
  };
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
  const selected = selectContractsForValues(contracts, values);

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

async function cmdPreflight(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "gate") {
    fail("用法: harness preflight gate [--dir d] [--config f] [--stage s] [--changed a,b] [--json] [--retain-on-failure]");
  }
  const { values } = parse(args.slice(1));
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);
  const contracts = loadRunnableContracts(dir);
  const selected = selectContractsForValues(contracts, values, cwd);
  const gate = await buildGate(values.properties as string | undefined);
  const config = loadHarnessConfig(cwd, values.config as string | undefined);
  const policy = loadSandboxPolicy(config);
  const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
  if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl =
    values["base-url"] as string;
  const report = await runGatePreflight({
    provider: createLazyDaytonaProvider(process.env),
    root: cwd,
    policy,
    contracts: selected,
    gate,
    ctx,
    environment: process.env,
    retainOnFailure: Boolean(values["retain-on-failure"]),
  });

  console.log(
    values.json
      ? renderGatePreflightJson(report)
      : renderGatePreflightPretty(report),
  );
  process.exitCode = report.outcome === "ready"
    ? 0
    : report.outcome === "blocked"
      ? 2
      : 1;
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

function loadRunnableContracts(dir: string): Contract[] {
  const { contracts, issues } = loadContracts(dir);
  if (issues.length) {
    for (const issue of issues) console.error(`  - ${issue.message}`);
    throw new Error("契约规格有问题,先修复");
  }
  const verificationFailures = contracts.map(verifyFrozen).filter((r) =>
    !r.ok
  );
  if (verificationFailures.length) {
    for (const failure of verificationFailures) {
      console.error(`  - ${failure.message}`);
    }
    throw new Error("冻结契约校验失败");
  }
  return contracts;
}

function claudeRunObservability(
  runId: string,
  config: DaytonaObservabilityConfig,
): RunRecordObservability {
  const runRoot = config.enabled
    ? claudeObservabilityPaths(config, runId, 1).runRoot
    : undefined;
  return {
    enabled: config.enabled,
    backend: config.backend,
    volumeName: config.volumeName,
    mountPath: config.mountPath,
    ...(runRoot ? { runRoot } : {}),
  };
}

function disabledRunObservability(): RunRecordObservability {
  return {
    enabled: false,
    backend: "disabled",
    volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
    mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  };
}

function runRecordDriverLabel(values: Record<string, unknown>): string {
  const driver = typeof values.driver === "string" ? values.driver : "scaffold";
  if (driver === "scaffold") return "scaffold";
  if (driver === "claude" || driver === "command") return `daytona(${driver})`;
  return driver;
}

function taskRecordMetadata(
  task: string,
  overrides?: SingleTaskRunOverrides,
) {
  return {
    description: task,
    ...(overrides?.taskId ? { taskId: overrides.taskId } : {}),
    ...(overrides?.seriesId ? { seriesId: overrides.seriesId } : {}),
    ...(overrides?.taskIndex !== undefined ? { index: overrides.taskIndex } : {}),
    ...(overrides?.taskTotal !== undefined ? { total: overrides.taskTotal } : {}),
  };
}

function seriesSummaryFromLedger(
  cwd: string,
  config: TaskSeriesConfig,
): { attempts: number; summary: RunOutcome["report"]["summary"] } {
  const ledger = readSeriesLedger(cwd, config.seriesId);
  const summary: RunOutcome["report"]["summary"] = {
    total: config.tasks.length,
    pass: 0,
    fail: 0,
    error: 0,
    needsReview: 0,
  };
  if (!ledger) return { attempts: 0, summary };

  for (const task of ledger.tasks) {
    if (task.status === "completed" || task.status === "ready_to_commit") {
      summary.pass += 1;
    } else if (task.status === "blocked") {
      summary.needsReview += 1;
    } else if (task.status === "escalated") {
      summary.fail += 1;
    } else if (task.status === "error") {
      summary.error += 1;
    }
  }

  return { attempts: ledger.tasks.length, summary };
}

function seriesChildRecords(cwd: string, parentRunId: string): RunRecordChild[] {
  return new RunStore(cwd).listRuns({
    kind: "series-task",
    parentRunId,
  })
    .sort((a, b) => Number(a.task.index) - Number(b.task.index))
    .map((record) => ({
      runId: record.runId,
      taskId: record.task.taskId!,
      index: record.task.index!,
      status: record.status,
      ...(record.outcome ? { outcome: record.outcome } : {}),
    }));
}

function attachSeriesChildren(cwd: string, parentRunId: string, recorder: {
  setChildren(children: RunRecordChild[]): void;
}): void {
  const children = seriesChildRecords(cwd, parentRunId);
  if (children.length > 0) recorder.setChildren(children);
}

export interface SingleTaskRunOverrides {
  selectedContracts?: Contract[];
  kind?: "single" | "series-task";
  parentRunId?: string;
  taskId?: string;
  seriesId?: string;
  taskIndex?: number;
  taskTotal?: number;
}

export interface SingleTaskRunResult {
  outcome: RunOutcome;
  runRecordPath: string;
  environmentName: string;
}

async function runSingleTask(
  args: string[],
  task: string,
  initialFeedback?: string,
  overrides?: SingleTaskRunOverrides,
): Promise<SingleTaskRunResult> {
  const { values } = parse(args);
  const cwd = process.cwd();
  const dir = resolve(cwd, values.dir as string);
  const runId = buildRunId();
  const runStore = new RunStore(cwd, { makeRunId: () => runId });
  const recorder = runStore.startRun({
    runId,
    kind: overrides?.kind ?? "single",
    ...(overrides?.parentRunId ? { parentRunId: overrides.parentRunId } : {}),
    task: taskRecordMetadata(task, overrides),
    driver: runRecordDriverLabel(values),
    observability: disabledRunObservability(),
    selectedContracts: overrides?.selectedContracts?.map((contract) => contract.id) ?? [],
  });

  try {
    const agent = selectAgent(values);
    let observability:
      | {
        runId: string;
        config: ReturnType<typeof loadDaytonaObservabilityConfig>;
      }
      | undefined;
    if (agent.kind === "claude") {
      const observabilityConfig = loadDaytonaObservabilityConfig(process.env);
      observability = { runId, config: observabilityConfig };
      recorder.setObservability(claudeRunObservability(runId, observabilityConfig));
    }

    const contracts = loadRunnableContracts(dir);

    const selected = overrides?.selectedContracts ?? (values.stage
      ? selectByStage(contracts, values.stage as string)
      : contracts);
    recorder.setSelectedContracts(selected.map((contract) => contract.id));
    const gate = await buildGate(values.properties as string | undefined);
    const ctx: RunContext = { cwd, verdicts: loadVerdicts(cwd) };
    if (values["base-url"]) (ctx as { baseUrl?: string }).baseUrl =
      values["base-url"] as string;
    const environmentName = agent.kind === "scaffold"
      ? "scaffold"
      : `daytona(${agent.kind})`;
    const config = loadHarnessConfig(
      cwd,
      values.config as string | undefined,
    );
    const policy = loadSandboxPolicy(config);
    if (agent.kind !== "scaffold") {
      recorder.recordEvent("gate.preflight.start", {
        selectedContracts: selected.map((contract) => contract.id),
      });
      console.log(`harness preflight gate · 契约 ${selected.length} 条`);
      let preflight = staticGatePreflightReport(selected, policy, ctx);
      if (
        preflight.readinessErrors.length === 0 &&
        preflight.remoteContracts.length > 0
      ) {
        preflight = await runGatePreflight({
          provider: createDaytonaSdkProvider(process.env),
          root: cwd,
          policy,
          contracts: selected,
          gate,
          ctx,
          environment: process.env,
          retainOnFailure: policy.retainOnFailure,
        });
      }
      recorder.recordEvent("gate.preflight.end", preflightEventSummary(preflight));
      const preflightBlocker = gatePreflightRunBlocker(preflight);
      if (preflightBlocker) throw new Error(preflightBlocker);
      const productRed = preflight.productFailures.length > 0
        ? ` · product-red ${preflight.productFailures.length}`
        : "";
      console.log(`harness preflight gate · readiness ok${productRed}`);
    }
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
        observability,
        onObservation(event, data) {
          recorder?.recordEvent(event, data);
          console.log(
            `    · ${event}: ${JSON.stringify(redactObservationData(data))}`,
          );
        },
      });
    }
    const budget = buildGenerationBudget(values, agent);

    console.log(
      `harness run · task="${task}" · environment=${environment.name}` +
      ` · 契约 ${selected.length} 条`,
    );
    console.log(
      `sandbox roots=[${policy.candidateRoots.join(", ")}]` +
      ` readOnly=[${policy.readOnlyPaths.join(", ")}]` +
      ` protected=[${policy.protectedPaths.join(", ")}]\n`,
    );
    const outcome = await runLoop({
      task, contracts: selected, gate, ctx,
      environment, budget,
      ...(initialFeedback ? { initialFeedback } : {}),
      onLog: (l) => console.log(l),
    });

    let recPath: string;
    recorder.complete({
      outcome: outcome.outcome,
      attempts: outcome.attempts,
      summary: outcome.report.summary,
      report: outcome.report,
      logs: outcome.logs,
      ...(outcome.publication ? { publication: outcome.publication } : {}),
      ...(outcome.action ? { action: outcome.action } : {}),
    });
    recPath = recorder.path;

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
    return {
      outcome,
      runRecordPath: recPath,
      environmentName: environment.name,
    };
  } catch (error) {
    recorder.fail(error);
    throw error;
  }
}

async function doRun(args: string[], task: string, initialFeedback?: string): Promise<void> {
  const result = await runSingleTask(args, task, initialFeedback);
  process.exitCode = result.outcome.outcome === "ready_for_mr"
    ? 0
    : result.outcome.outcome === "blocked"
      ? 2
      : 1;
}

async function cmdRun(args: string[]): Promise<void> {
  const { values, positionals } = parse(args);
  const task = positionals[0];
  if (task) {
    await doRun(args, task);
    return;
  }

  const cwd = process.cwd();
  const config = loadHarnessConfig(cwd, values.config as string | undefined);
  const seriesConfig = loadTaskSeriesConfig(config);
  if (!seriesConfig) {
    fail('用法: harness run "<task 描述>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s]\n或在 harness.config.json 配置 tasks');
  }

  const dir = resolve(cwd, values.dir as string);
  const seriesRunId = buildRunId();
  const seriesRecorder = new RunStore(cwd, { makeRunId: () => seriesRunId }).startRun({
    runId: seriesRunId,
    kind: "series",
    task: {
      description: `task series ${seriesConfig.seriesId}`,
      seriesId: seriesConfig.seriesId,
      total: seriesConfig.tasks.length,
    },
    driver: `series(${values.driver as string})`,
    observability: disabledRunObservability(),
  });

  let result;
  const skippedTaskIds: string[] = [];
  try {
    const contracts = loadRunnableContracts(dir);
    console.log(
      `harness series · id=${seriesConfig.seriesId} · tasks=${seriesConfig.tasks.length}`,
    );
    result = await runTaskSeries({
      cwd,
      config: seriesConfig,
      contracts,
      fallbackStage: values.stage as string | undefined,
      onTaskSkipped: (input) => {
        skippedTaskIds.push(input.task.id);
        console.log(
          `[${input.index}/${input.total}] ${input.task.id} · skipped completed (taskHash unchanged)`,
        );
      },
      executeTask: async (input) => {
        console.log(`\n[${input.index}/${input.total}] ${input.task.id}`);
        return runSingleTask(args, input.task.task, undefined, {
          kind: "series-task",
          parentRunId: seriesRunId,
          taskId: input.task.id,
          seriesId: seriesConfig.seriesId,
          taskIndex: input.index,
          taskTotal: input.total,
          selectedContracts: input.contracts,
        });
      },
      recordTaskSetupError: (input) => {
        const childRunId = buildRunId();
        const childRecorder = new RunStore(cwd, { makeRunId: () => childRunId }).startRun({
          runId: childRunId,
          kind: "series-task",
          parentRunId: seriesRunId,
          task: {
            description: input.task.task,
            taskId: input.task.id,
            seriesId: seriesConfig.seriesId,
            index: input.index,
            total: input.total,
          },
          driver: runRecordDriverLabel(values),
          observability: disabledRunObservability(),
        });
        childRecorder.fail(input.error, {
          logs: [
            `series task setup failed: ${
              input.error instanceof Error ? input.error.message : String(input.error)
            }`,
          ],
        });
        return childRecorder.path;
      },
    });
  } catch (error) {
    attachSeriesChildren(cwd, seriesRunId, seriesRecorder);
    seriesRecorder.fail(error);
    throw error;
  }

  const progress = seriesSummaryFromLedger(cwd, seriesConfig);
  attachSeriesChildren(cwd, seriesRunId, seriesRecorder);
  if (result.outcome === "completed") {
    const logs = ["series completed"];
    if (skippedTaskIds.length > 0) {
      logs.push(`skipped completed tasks: ${skippedTaskIds.join(", ")}`);
    }
    seriesRecorder.complete({
      outcome: "completed",
      attempts: progress.attempts,
      summary: progress.summary,
      logs,
    });
    console.log("\n✓ series completed");
    process.exitCode = 0;
    return;
  }

  const stopLog = `series stopped at ${result.taskId}: ${result.outcome}` +
    `${result.reason ? ` ${result.reason}` : ""}`;
  const stopDetails = {
    outcome: result.outcome === "error" ? "error" as const : result.outcome,
    attempts: progress.attempts,
    summary: progress.summary,
    logs: [stopLog],
  };
  if (result.outcome === "error") {
    seriesRecorder.fail(result.reason ?? stopLog, stopDetails);
  } else {
    seriesRecorder.complete(stopDetails);
  }
  console.log(
    `\n■ series stopped at ${result.taskId}: ${result.outcome}` +
    `${result.reason ? ` ${result.reason}` : ""}`,
  );
  process.exitCode = result.outcome === "blocked" ? 2 : 1;
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

function cmdRuns(args: string[]): void {
  const { values, positionals } = parse(args);
  const sub = positionals[0] ?? "list";
  const store = new RunStore(process.cwd());

  if (sub === "list") {
    const runs = store.listRuns({
      ...(values["task-id"] ? { taskId: values["task-id"] as string } : {}),
      ...(values["series-id"] ? { seriesId: values["series-id"] as string } : {}),
    });
    if (values.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log("没有 run 记录");
      return;
    }
    for (const run of runs) {
      console.log(
        `${run.runId} · ${run.kind} · ${run.status}` +
          ` · ${run.driver} · ${run.task.description}`,
      );
    }
    return;
  }

  if (sub === "show") {
    const runId = positionals[1];
    if (!runId) fail("用法: harness runs show <runId> [--json]");
    const run = store.readRun(runId);
    if (!run) fail(`未找到 run 记录: ${runId}`);
    if (values.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    console.log(`${run.runId} · ${run.kind} · ${run.status}`);
    console.log(`task: ${run.task.description}`);
    console.log(`driver: ${run.driver}`);
    if (run.outcome) console.log(`outcome: ${run.outcome}`);
    if (run.summary) {
      console.log(
        `summary: pass ${run.summary.pass}/${run.summary.total}, ` +
          `fail ${run.summary.fail}, error ${run.summary.error}, review ${run.summary.needsReview}`,
      );
    }
    if (run.report) console.log(`report: ${run.report.outcome}`);
    return;
  }

  fail("用法: harness runs [list|show <runId>] [--json] [--task-id id] [--series-id id]");
}

function cmdCreate(args: string[]): void {
  const { values, positionals } = parse(args);
  const target = resolve(process.cwd(), positionals[0] ?? ".");
  const { created, skipped, git } = createProject(target, values.force as boolean);
  console.log(`✓ 初始化 harness 项目于 ${target}`);
  console.log(`  git: ${git === "initialized" ? "initialized" : "existing repository"}`);
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
  harness run  "<task>" [--driver scaffold|command|claude] [--agent-cmd "..."] [--stage s] [--max-attempts n] [--max-ms ms] # 默认 max-ms=6000000
  harness fix  [--driver ...] [--stage s]        # 先取门禁诊断,再驱动 driver 修复迭代
  harness review [--resolve <id> --option <o> --by <name> [--reason ...]]   # 汇总/记录人工决策
  harness status                                 # 项目状态(契约/冻结/裁决/最近 run)
  harness runs list [--json] [--task-id id] [--series-id id]
  harness runs show <runId> [--json]

门禁(验证层):
  harness check [--dir d] [--changed a,b | --stage s] [--config f] [--base-url u] [--properties m] [--json]
  harness gate <stage> [...]                     # = check --stage <stage>
  harness preflight gate [--dir d] [--config f] [--stage s] [--changed a,b] [--json] # 在 Daytona Gate sandbox 中演练 setup/契约
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
    case "runs": cmdRuns(rest); break;
    case "check": await cmdCheck(rest); break;
    case "gate": await cmdGate(rest); break;
    case "preflight": await cmdPreflight(rest); break;
    case "meta": await cmdMeta(rest); break;
    case "explain": cmdExplain(rest); break;
    case "contract": cmdContract(rest); break;
    case "help": case "--help": case "-h": help(); break;
    default: console.error(`未知命令: ${command}\n`); help(); process.exit(1);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

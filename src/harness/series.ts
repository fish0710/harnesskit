import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { selectByStage } from "../selector.js";
import type { Contract } from "../types.js";
import type { RunOutcome } from "./run.js";

const SERIES_FIELDS = new Set(["id"]);
const TASK_DEFAULTS_FIELDS = new Set(["gate"]);
const AUTO_COMMIT_FIELDS = new Set(["enabled", "messageTemplate"]);
const TASK_FIELDS = new Set(["id", "task", "gate", "commitMessage"]);
const GATE_FIELDS = new Set(["contracts", "stage"]);
const MESSAGE_PLACEHOLDERS = new Set(["id", "index", "total"]);
const GIT_PATHSPEC_MAGIC_PREFIXES = [":(", ":/", ":!", ":^"];

export interface TaskGateSelector {
  contracts?: string[];
  stage?: string;
}

export interface TaskDefaults {
  gate?: TaskGateSelector;
}

export interface AutoCommitConfig {
  enabled: boolean;
  messageTemplate: string;
}

export interface TaskSeriesTask {
  id: string;
  task: string;
  gate?: TaskGateSelector;
  commitMessage?: string;
}

export interface TaskSeriesConfig {
  seriesId: string;
  taskDefaults: TaskDefaults;
  autoCommit: AutoCommitConfig;
  tasks: TaskSeriesTask[];
}

export interface CommitMessageInput {
  template: string;
  taskId: string;
  seriesId: string;
  taskIndex: number;
  taskCount: number;
}

export interface CommitPublishedChangesInput {
  cwd: string;
  changedFiles: string[];
  message: string;
}

export type CommitPublishedChangesResult =
  | { committed: false }
  | { committed: true; commit: string };

export type SeriesStatus = "running" | "completed" | "error";

export type SeriesTaskStatus =
  | "pending"
  | "running"
  | "ready_to_commit"
  | "completed"
  | "blocked"
  | "escalated"
  | "error";

export interface SeriesLedgerTask {
  id: string;
  taskHash: string;
  status: SeriesTaskStatus;
  changedFiles?: string[];
  commit?: string;
  runRecord?: string;
  startedAt?: string;
  completedAt?: string;
  errorReason?: string;
}

export interface SeriesLedger {
  schemaVersion: 1;
  seriesId: string;
  status: SeriesStatus;
  configHash: string;
  createdAt: string;
  updatedAt: string;
  tasks: SeriesLedgerTask[];
}

export type TaskResumeDecision =
  | { action: "skip" }
  | { action: "commit" }
  | { action: "run" }
  | { action: "stop"; reason: string };

export interface SeriesTaskExecutionInput {
  task: TaskSeriesTask;
  contracts: Contract[];
  index: number;
  total: number;
}

export interface SeriesTaskExecutionResult {
  outcome: RunOutcome;
  runRecordPath: string;
}

export interface RunTaskSeriesInput {
  cwd: string;
  config: TaskSeriesConfig;
  contracts: Contract[];
  fallbackStage?: string;
  executeTask(input: SeriesTaskExecutionInput): Promise<SeriesTaskExecutionResult>;
}

export type RunTaskSeriesResult =
  | { outcome: "completed" }
  | { outcome: "blocked" | "escalated" | "error"; taskId: string; reason?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  known: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`未知 ${label} 字段: ${key}`);
  }
}

function assertSafeSegment(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${field} 必须是安全路径片段`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${field} 必须是字符串数组`);
  }
  return [...value];
}

function validateCommitTemplate(template: string, field: string): string {
  for (const match of template.matchAll(/\{([^}]+)\}/g)) {
    const placeholder = match[1]!;
    if (!MESSAGE_PLACEHOLDERS.has(placeholder)) {
      throw new Error(`未知 commit message placeholder: ${placeholder}`);
    }
  }
  if (template.trim() === "") {
    throw new TypeError(`${field} 必须是非空字符串`);
  }
  return template;
}

function isHarnessRuntimePath(path: string): boolean {
  return path === ".harness" || path.startsWith(".harness/");
}

function validateChangedFilePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\")
  ) {
    throw new Error(`changedFiles 路径无效: ${path}`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`changedFiles 路径无效: ${path}`);
  }
  if (GIT_PATHSPEC_MAGIC_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`changedFiles 路径包含 Git pathspec magic: ${path}`);
  }

  return path;
}

function runGit(
  cwd: string,
  args: string[],
  options?: { input?: string; allowNonZero?: boolean; literalPathspecs?: boolean },
): { stdout: string; stderr: string; status: number | null } {
  const gitArgs = options?.literalPathspecs ? ["--literal-pathspecs", ...args] : args;
  const result = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    input: options?.input,
  });

  if (!options?.allowNonZero && result.status !== 0) {
    const reason = result.stderr.trim() || result.error?.message || "unknown";
    throw new Error(`git ${gitArgs.join(" ")} 失败: ${reason}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function ensureGitWorktree(cwd: string): void {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowNonZero: true });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error(`工作区不是 Git 工作树: ${cwd}`);
  }
}

function isRenameOrCopyPorcelainRecord(record: string): boolean {
  return record[0] === "R" || record[1] === "R" || record[0] === "C" || record[1] === "C";
}

function parsePorcelainZChanges(status: string): string[][] {
  const records = status.split("\0");
  const changes: string[][] = [];

  for (let index = 0; index < records.length;) {
    const record = records[index++]!;
    if (record.length === 0) continue;

    const paths = [record.slice(3)];
    if (isRenameOrCopyPorcelainRecord(record) && index < records.length) {
      const source = records[index++]!;
      if (source.length > 0) paths.push(source);
    }
    changes.push(paths);
  }

  return changes;
}

function optionalGate(value: unknown, field: string): TaskGateSelector | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${field} 必须是普通对象`);
  rejectUnknownFields(value, GATE_FIELDS, field);

  const gate: TaskGateSelector = {};
  if (hasOwn(value, "contracts")) {
    gate.contracts = stringArray(value.contracts, `${field}.contracts`);
  }
  if (hasOwn(value, "stage")) {
    if (typeof value.stage !== "string" || value.stage.trim() === "") {
      throw new TypeError(`${field}.stage 必须是非空字符串`);
    }
    gate.stage = value.stage;
  }
  return gate;
}

function loadSeriesId(value: unknown): string {
  if (value === undefined) return "default";
  if (!isRecord(value)) throw new TypeError("series 必须是普通对象");
  rejectUnknownFields(value, SERIES_FIELDS, "series");
  if (!hasOwn(value, "id")) return "default";
  return assertSafeSegment(value.id, "series.id");
}

function loadTaskDefaults(value: unknown): TaskDefaults {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("taskDefaults 必须是普通对象");
  rejectUnknownFields(value, TASK_DEFAULTS_FIELDS, "taskDefaults");

  const defaults: TaskDefaults = {};
  if (hasOwn(value, "gate")) defaults.gate = optionalGate(value.gate, "taskDefaults.gate");
  return defaults;
}

function loadAutoCommit(value: unknown): AutoCommitConfig {
  if (value === undefined) {
    return { enabled: true, messageTemplate: "harness: {id}" };
  }
  if (!isRecord(value)) throw new TypeError("autoCommit 必须是普通对象");
  rejectUnknownFields(value, AUTO_COMMIT_FIELDS, "autoCommit");

  const enabled = hasOwn(value, "enabled") ? value.enabled : true;
  if (typeof enabled !== "boolean") {
    throw new TypeError("autoCommit.enabled 必须是 boolean");
  }

  const messageTemplate = hasOwn(value, "messageTemplate")
    ? value.messageTemplate
    : "harness: {id}";
  if (typeof messageTemplate !== "string") {
    throw new TypeError("autoCommit.messageTemplate 必须是非空字符串");
  }

  return {
    enabled,
    messageTemplate: validateCommitTemplate(messageTemplate, "autoCommit.messageTemplate"),
  };
}

function loadTask(value: unknown, ids: Set<string>): TaskSeriesTask {
  if (!isRecord(value)) throw new TypeError("tasks 项必须是普通对象");
  rejectUnknownFields(value, TASK_FIELDS, "tasks");

  const id = assertSafeSegment(value.id, "tasks.id");
  if (ids.has(id)) throw new Error(`重复 task id: ${id}`);
  ids.add(id);

  if (typeof value.task !== "string" || value.task.trim() === "") {
    throw new TypeError(`tasks.${id}.task 必须是非空字符串`);
  }

  const task: TaskSeriesTask = {
    id,
    task: value.task,
  };

  if (hasOwn(value, "gate")) task.gate = optionalGate(value.gate, `tasks.${id}.gate`);

  if (hasOwn(value, "commitMessage")) {
    if (typeof value.commitMessage !== "string") {
      throw new TypeError(`tasks.${id}.commitMessage 必须是非空字符串`);
    }
    task.commitMessage = validateCommitTemplate(
      value.commitMessage,
      `tasks.${id}.commitMessage`,
    );
  }

  return task;
}

function mergeGateSelectors(
  defaults: TaskDefaults,
  task: TaskSeriesTask,
): { hasExplicitSelector: boolean; contracts: string[]; stage?: string } {
  const defaultGate = defaults.gate;
  const taskGate = task.gate;
  return {
    hasExplicitSelector: defaultGate !== undefined || taskGate !== undefined,
    contracts: [
      ...(defaultGate?.contracts ?? []),
      ...(taskGate?.contracts ?? []),
    ],
    stage: taskGate?.stage ?? defaultGate?.stage,
  };
}

function canonicalizeGate(gate: TaskGateSelector | undefined): {
  contracts?: string[];
  stage?: string;
} | null {
  if (!gate) return null;
  const canonical: { contracts?: string[]; stage?: string } = {};
  if (gate.contracts !== undefined) canonical.contracts = [...gate.contracts];
  if (gate.stage !== undefined) canonical.stage = gate.stage;
  return canonical;
}

function effectiveGateForHash(
  defaults: TaskDefaults,
  task: TaskSeriesTask,
): { contracts?: string[]; stage?: string } | null {
  const selector = mergeGateSelectors(defaults, task);
  if (!selector.hasExplicitSelector) return null;
  return canonicalizeGate({
    ...(selector.contracts.length > 0 ? { contracts: selector.contracts } : {}),
    ...(selector.stage !== undefined ? { stage: selector.stage } : {}),
  });
}

function isSeriesStatus(value: unknown): value is SeriesStatus {
  return value === "running" || value === "completed" || value === "error";
}

function isSeriesTaskStatus(value: unknown): value is SeriesTaskStatus {
  return value === "pending" ||
    value === "running" ||
    value === "ready_to_commit" ||
    value === "completed" ||
    value === "blocked" ||
    value === "escalated" ||
    value === "error";
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} 无效`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value, field);
}

function parseLedgerTask(value: unknown): SeriesLedgerTask {
  if (!isRecord(value)) throw new Error("series ledger task 无效");
  const id = assertSafeSegment(value.id, "series ledger task id");
  if (typeof value.taskHash !== "string" || !/^[a-f0-9]{64}$/.test(value.taskHash)) {
    throw new Error("series ledger taskHash 无效");
  }
  if (!isSeriesTaskStatus(value.status)) {
    throw new Error("series ledger task status 无效");
  }

  const task: SeriesLedgerTask = {
    id,
    taskHash: value.taskHash,
    status: value.status,
    changedFiles: optionalStringArray(value.changedFiles, "series ledger changedFiles"),
    commit: optionalString(value.commit, "series ledger commit"),
    runRecord: optionalString(value.runRecord, "series ledger runRecord"),
    startedAt: optionalString(value.startedAt, "series ledger startedAt"),
    completedAt: optionalString(value.completedAt, "series ledger completedAt"),
    errorReason: optionalString(value.errorReason, "series ledger errorReason"),
  };

  if (task.status === "ready_to_commit") {
    if (task.changedFiles === undefined) {
      throw new Error("series ledger changedFiles 无效");
    }
    if (task.runRecord === undefined) {
      throw new Error("series ledger runRecord 无效");
    }
  }

  if (task.status === "completed" && task.completedAt === undefined) {
    throw new Error("series ledger completedAt 无效");
  }

  if (
    (task.status === "blocked" || task.status === "escalated" || task.status === "error") &&
    task.errorReason === undefined &&
    task.runRecord === undefined
  ) {
    throw new Error("series ledger terminal task 缺少 errorReason 或 runRecord");
  }

  return task;
}

function parseLedger(value: unknown, seriesId: string): SeriesLedger {
  if (!isRecord(value)) throw new Error("series ledger 格式无效");
  if (value.schemaVersion !== 1) throw new Error("series ledger schemaVersion 无效");
  if (value.seriesId !== seriesId) throw new Error("series ledger seriesId 不匹配");
  if (!isSeriesStatus(value.status)) throw new Error("series ledger status 无效");
  if (typeof value.configHash !== "string" || !/^[a-f0-9]{64}$/.test(value.configHash)) {
    throw new Error("series ledger configHash 无效");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("series ledger timestamp 无效");
  }
  if (!Array.isArray(value.tasks)) throw new Error("series ledger tasks 无效");
  const ids = new Set<string>();

  return {
    schemaVersion: 1,
    seriesId,
    status: value.status,
    configHash: value.configHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    tasks: value.tasks.map((task) => {
      const parsedTask = parseLedgerTask(task);
      if (ids.has(parsedTask.id)) {
        throw new Error(`重复 series ledger task id: ${parsedTask.id}`);
      }
      ids.add(parsedTask.id);
      return parsedTask;
    }),
  };
}

export function loadTaskSeriesConfig(config: unknown): TaskSeriesConfig | undefined {
  if (!isRecord(config)) throw new TypeError("Harness 配置必须是普通对象");
  if (!hasOwn(config, "tasks")) return undefined;
  if (!Array.isArray(config.tasks)) throw new TypeError("tasks 必须是数组");
  if (config.tasks.length === 0) throw new Error("tasks 必须是非空数组");

  const ids = new Set<string>();
  return {
    seriesId: loadSeriesId(config.series),
    taskDefaults: loadTaskDefaults(config.taskDefaults),
    autoCommit: loadAutoCommit(config.autoCommit),
    tasks: config.tasks.map((task) => loadTask(task, ids)),
  };
}

export function selectTaskContracts(input: {
  contracts: Contract[];
  task: TaskSeriesTask;
  defaults: TaskDefaults;
  fallbackStage?: string;
}): Contract[] {
  const selector = mergeGateSelectors(input.defaults, input.task);
  if (!selector.hasExplicitSelector) {
    return input.fallbackStage
      ? selectByStage(input.contracts, input.fallbackStage)
      : [...input.contracts];
  }

  const byId = new Map(input.contracts.map((contract) => [contract.id, contract]));
  const selected = new Map<string, Contract>();

  for (const id of selector.contracts) {
    const contract = byId.get(id);
    if (!contract) throw new Error(`未知契约: ${id}`);
    selected.set(contract.id, contract);
  }

  if (selector.stage !== undefined) {
    for (const contract of selectByStage(input.contracts, selector.stage)) {
      selected.set(contract.id, contract);
    }
  }

  const result = [...selected.values()];
  if (result.length === 0) {
    throw new Error(`task ${input.task.id} 未选择任何契约`);
  }
  return result;
}

export function seriesLedgerPath(cwd: string, seriesId: string): string {
  return join(cwd, ".harness", "series", `${assertSafeSegment(seriesId, "series.id")}.json`);
}

export function readSeriesLedger(cwd: string, seriesId: string): SeriesLedger | undefined {
  const path = seriesLedgerPath(cwd, seriesId);
  if (!existsSync(path)) return undefined;

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `series ledger JSON 无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseLedger(parsed, seriesId);
}

export function writeSeriesLedger(cwd: string, ledger: SeriesLedger): string {
  const normalized = parseLedger(ledger, ledger.seriesId);
  const path = seriesLedgerPath(cwd, normalized.seriesId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  renameSync(tempPath, path);
  return path;
}

export function configHash(config: TaskSeriesConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}

export function taskHash(
  task: TaskSeriesTask,
  autoCommit: AutoCommitConfig,
  defaults: TaskDefaults,
): string {
  const payload = {
    id: task.id,
    task: task.task,
    gate: effectiveGateForHash(defaults, task),
    commitMessage: task.commitMessage ?? null,
    autoCommit: {
      enabled: autoCommit.enabled,
      messageTemplate: autoCommit.messageTemplate,
    },
  };

  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function renderCommitMessage(input: CommitMessageInput): string {
  const summary = input.template
    .replaceAll("{id}", input.taskId)
    .replaceAll("{index}", String(input.taskIndex))
    .replaceAll("{total}", String(input.taskCount));
  return [
    summary,
    "",
    `Harness-Task-Id: ${input.taskId}`,
    `Harness-Series-Id: ${input.seriesId}`,
  ].join("\n");
}

export function ensureCleanGitWorktree(cwd: string): void {
  ensureGitWorktree(cwd);
  const status = runGit(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  ).stdout;
  const dirtyPaths = new Set<string>();

  for (const paths of parsePorcelainZChanges(status)) {
    for (const path of paths) {
      if (!isHarnessRuntimePath(path)) {
        dirtyPaths.add(path);
      }
    }
  }

  if (dirtyPaths.size > 0) {
    throw new Error(`工作区存在未提交变更: ${[...dirtyPaths].sort().join(", ")}`);
  }
}

export function commitPublishedChanges(
  input: CommitPublishedChangesInput,
): CommitPublishedChangesResult {
  ensureGitWorktree(input.cwd);
  const publishedFiles = input.changedFiles
    .map((path) => validateChangedFilePath(path))
    .filter((path) => !isHarnessRuntimePath(path));

  if (publishedFiles.length === 0) return { committed: false };

  runGit(input.cwd, ["add", "--", ...publishedFiles], { literalPathspecs: true });

  const publishedPathSet = new Set(publishedFiles);
  const staged = runGit(input.cwd, ["diff", "--cached", "--name-only", "-z"])
    .stdout
    .split("\0")
    .filter((path) => path.length > 0 && publishedPathSet.has(path));
  if (staged.length === 0) return { committed: false };

  runGit(
    input.cwd,
    ["commit", "--only", "-F", "-", "--", ...publishedFiles],
    { input: input.message, literalPathspecs: true },
  );

  return {
    committed: true,
    commit: runGit(input.cwd, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}

export function decideTaskResume(input: {
  taskId: string;
  taskHash: string;
  ledgerTask?: SeriesLedgerTask;
}): TaskResumeDecision {
  const existing = input.ledgerTask;
  if (!existing) return { action: "run" };

  if (existing.status === "pending" || existing.status === "running") {
    return { action: "run" };
  }

  if (existing.status === "completed") {
    if (existing.taskHash !== input.taskHash) {
      return {
        action: "stop",
        reason: `task ${input.taskId} 已完成但配置已变化`,
      };
    }
    return { action: "skip" };
  }

  if (existing.status === "ready_to_commit") {
    if (existing.taskHash === input.taskHash) {
      return { action: "commit" };
    }
    return {
      action: "stop",
      reason: `task ${input.taskId} 已处于 ready_to_commit 状态，但当前配置与已发布文件不一致`,
    };
  }

  if (
    existing.status === "blocked" ||
    existing.status === "escalated" ||
    existing.status === "error"
  ) {
    return {
      action: "stop",
      reason: `task ${input.taskId} 已处于 ${existing.status} 状态，需人工处理后再继续`,
    };
  }

  return { action: "run" };
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialSeriesLedger(config: TaskSeriesConfig): SeriesLedger {
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    seriesId: config.seriesId,
    status: "running",
    configHash: configHash(config),
    createdAt: timestamp,
    updatedAt: timestamp,
    tasks: [],
  };
}

function updateLedgerTask(ledger: SeriesLedger, task: SeriesLedgerTask): void {
  const index = ledger.tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) {
    ledger.tasks.push(task);
  } else {
    ledger.tasks[index] = task;
  }
}

function writeUpdatedLedger(cwd: string, ledger: SeriesLedger): void {
  ledger.updatedAt = nowIso();
  writeSeriesLedger(cwd, ledger);
}

function runOutcomeReason(outcome: RunOutcome): string | undefined {
  return outcome.action && "reason" in outcome.action ? outcome.action.reason : undefined;
}

function commitMessageForTask(input: {
  config: TaskSeriesConfig;
  task: TaskSeriesTask;
  index: number;
  total: number;
}): string {
  return renderCommitMessage({
    template: input.task.commitMessage ?? input.config.autoCommit.messageTemplate,
    taskId: input.task.id,
    seriesId: input.config.seriesId,
    taskIndex: input.index,
    taskCount: input.total,
  });
}

export async function runTaskSeries(input: RunTaskSeriesInput): Promise<RunTaskSeriesResult> {
  const { cwd, config } = input;
  const total = config.tasks.length;
  const ledger = readSeriesLedger(cwd, config.seriesId) ?? initialSeriesLedger(config);

  for (let taskIndex = 0; taskIndex < config.tasks.length; taskIndex++) {
    const task = config.tasks[taskIndex]!;
    const index = taskIndex + 1;
    const currentTaskHash = taskHash(task, config.autoCommit, config.taskDefaults);
    const existingTask = ledger.tasks.find((entry) => entry.id === task.id);
    const decision = decideTaskResume({
      taskId: task.id,
      taskHash: currentTaskHash,
      ledgerTask: existingTask,
    });

    if (decision.action === "skip") {
      continue;
    }

    if (decision.action === "stop") {
      ledger.status = "error";
      writeUpdatedLedger(cwd, ledger);
      return { outcome: "error", taskId: task.id, reason: decision.reason };
    }

    if (decision.action === "commit") {
      const readyTask = existingTask!;
      const commitResult = config.autoCommit.enabled
        ? commitPublishedChanges({
          cwd,
          changedFiles: readyTask.changedFiles ?? [],
          message: commitMessageForTask({ config, task, index, total }),
        })
        : { committed: false as const };
      const readyTaskWithCommit: SeriesLedgerTask = commitResult.committed
        ? { ...readyTask, commit: commitResult.commit }
        : readyTask;
      if (commitResult.committed) {
        updateLedgerTask(ledger, readyTaskWithCommit);
        writeUpdatedLedger(cwd, ledger);
      }
      if (config.autoCommit.enabled) ensureCleanGitWorktree(cwd);
      const completedTask: SeriesLedgerTask = {
        ...readyTaskWithCommit,
        status: "completed",
        completedAt: nowIso(),
      };
      updateLedgerTask(ledger, completedTask);
      writeUpdatedLedger(cwd, ledger);
      continue;
    }

    if (config.autoCommit.enabled) ensureCleanGitWorktree(cwd);

    const selectedContracts = selectTaskContracts({
      contracts: input.contracts,
      task,
      defaults: config.taskDefaults,
      fallbackStage: input.fallbackStage,
    });
    updateLedgerTask(ledger, {
      id: task.id,
      taskHash: currentTaskHash,
      status: "running",
      startedAt: nowIso(),
    });
    writeUpdatedLedger(cwd, ledger);

    let execution: SeriesTaskExecutionResult;
    try {
      execution = await input.executeTask({
        task,
        contracts: selectedContracts,
        index,
        total,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateLedgerTask(ledger, {
        id: task.id,
        taskHash: currentTaskHash,
        status: "error",
        startedAt: ledger.tasks.find((entry) => entry.id === task.id)?.startedAt,
        errorReason: reason,
      });
      ledger.status = "error";
      writeUpdatedLedger(cwd, ledger);
      return { outcome: "error", taskId: task.id, reason };
    }

    const reason = runOutcomeReason(execution.outcome);
    if (execution.outcome.outcome === "blocked") {
      updateLedgerTask(ledger, {
        id: task.id,
        taskHash: currentTaskHash,
        status: "blocked",
        startedAt: ledger.tasks.find((entry) => entry.id === task.id)?.startedAt,
        runRecord: execution.runRecordPath,
        ...(reason !== undefined ? { errorReason: reason } : {}),
      });
      writeUpdatedLedger(cwd, ledger);
      return { outcome: "blocked", taskId: task.id, reason };
    }

    if (execution.outcome.outcome === "escalated") {
      updateLedgerTask(ledger, {
        id: task.id,
        taskHash: currentTaskHash,
        status: "escalated",
        startedAt: ledger.tasks.find((entry) => entry.id === task.id)?.startedAt,
        runRecord: execution.runRecordPath,
        ...(reason !== undefined ? { errorReason: reason } : {}),
      });
      ledger.status = "error";
      writeUpdatedLedger(cwd, ledger);
      return { outcome: "escalated", taskId: task.id, reason };
    }

    const changedFiles = execution.outcome.publication?.changedFiles ?? [];
    const readyTask: SeriesLedgerTask = {
      id: task.id,
      taskHash: currentTaskHash,
      status: "ready_to_commit",
      startedAt: ledger.tasks.find((entry) => entry.id === task.id)?.startedAt,
      changedFiles,
      runRecord: execution.runRecordPath,
    };
    updateLedgerTask(ledger, readyTask);
    writeUpdatedLedger(cwd, ledger);

    const commitResult = config.autoCommit.enabled
      ? commitPublishedChanges({
        cwd,
        changedFiles,
        message: commitMessageForTask({ config, task, index, total }),
      })
      : { committed: false as const };
    const readyTaskWithCommit: SeriesLedgerTask = commitResult.committed
      ? { ...readyTask, commit: commitResult.commit }
      : readyTask;
    if (commitResult.committed) {
      updateLedgerTask(ledger, readyTaskWithCommit);
      writeUpdatedLedger(cwd, ledger);
    }
    if (config.autoCommit.enabled) ensureCleanGitWorktree(cwd);
    const completedTask: SeriesLedgerTask = {
      ...readyTaskWithCommit,
      status: "completed",
      completedAt: nowIso(),
    };
    updateLedgerTask(ledger, completedTask);
    writeUpdatedLedger(cwd, ledger);
  }

  ledger.status = "completed";
  writeUpdatedLedger(cwd, ledger);
  return { outcome: "completed" };
}

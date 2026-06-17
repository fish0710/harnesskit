import { createHash } from "node:crypto";
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

const SERIES_FIELDS = new Set(["id"]);
const TASK_DEFAULTS_FIELDS = new Set(["gate"]);
const AUTO_COMMIT_FIELDS = new Set(["enabled", "messageTemplate"]);
const TASK_FIELDS = new Set(["id", "task", "gate", "commitMessage"]);
const GATE_FIELDS = new Set(["contracts", "stage"]);
const MESSAGE_PLACEHOLDERS = new Set(["id", "index", "total"]);

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
  if (typeof value.id !== "string" || value.id === "") {
    throw new Error("series ledger task id 无效");
  }
  if (typeof value.taskHash !== "string" || !/^[a-f0-9]{64}$/.test(value.taskHash)) {
    throw new Error("series ledger taskHash 无效");
  }
  if (!isSeriesTaskStatus(value.status)) {
    throw new Error("series ledger task status 无效");
  }

  return {
    id: value.id,
    taskHash: value.taskHash,
    status: value.status,
    changedFiles: optionalStringArray(value.changedFiles, "series ledger changedFiles"),
    commit: optionalString(value.commit, "series ledger commit"),
    runRecord: optionalString(value.runRecord, "series ledger runRecord"),
    startedAt: optionalString(value.startedAt, "series ledger startedAt"),
    completedAt: optionalString(value.completedAt, "series ledger completedAt"),
    errorReason: optionalString(value.errorReason, "series ledger errorReason"),
  };
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

  return {
    schemaVersion: 1,
    seriesId,
    status: value.status,
    configHash: value.configHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    tasks: value.tasks.map((task) => parseLedgerTask(task)),
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `series ledger JSON 无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseLedger(parsed, seriesId);
}

export function writeSeriesLedger(cwd: string, ledger: SeriesLedger): string {
  const path = seriesLedgerPath(cwd, ledger.seriesId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(ledger, null, 2), "utf8");
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

export function decideTaskResume(input: {
  taskId: string;
  taskHash: string;
  ledgerTask?: SeriesLedgerTask;
}): TaskResumeDecision {
  const existing = input.ledgerTask;
  if (!existing) return { action: "run" };

  if (existing.status === "completed") {
    if (existing.taskHash !== input.taskHash) {
      return {
        action: "stop",
        reason: `task ${input.taskId} 已完成但配置已变化`,
      };
    }
    return { action: "skip" };
  }

  if (existing.status === "ready_to_commit" && existing.taskHash === input.taskHash) {
    return { action: "commit" };
  }

  return { action: "run" };
}

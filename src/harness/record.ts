import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "./run.js";
import type { GateReport } from "../types.js";
import type { PublicationResult } from "./sandbox/publish.js";

const runsDir = (cwd: string) => join(cwd, ".harness", "runs");

function assertSafeRunId(runId: string): void {
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error("runId must be a non-empty safe path segment");
  }
}

function snapshotJsonValue(value: unknown): unknown {
  const stack: object[] = [];
  const clone = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "undefined") return null;
    if (typeof item === "symbol" || typeof item === "function") {
      return "[unserializable]";
    }
    if (typeof item === "object" && item !== null) {
      if (stack.includes(item)) return "[circular]";
      stack.push(item);
      try {
        if (Array.isArray(item)) {
          return item.map((entry) => clone(entry));
        }
        return Object.fromEntries(
          Object.entries(item).map(([key, entry]) => [
            key,
            clone(entry),
          ]),
        );
      } finally {
        stack.pop();
      }
    }
    return item;
  };
  const snapshot = clone(value);
  return snapshot === undefined ? null : snapshot;
}

export interface RunRecord {
  at: string;
  task: string;
  driver: string;
  outcome: RunOutcome["outcome"];
  attempts: number;
  summary: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
}

export type RunRecordStatus = "running" | "completed" | "error";
export type RunRecordKind = "single" | "series" | "series-task";
export type RunRecordOutcome = RunOutcome["outcome"] | "completed" | "error";

export interface RunRecordRepo {
  root: string;
  gitRoot?: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
}

export interface RunRecordTask {
  description: string;
  taskId?: string;
  seriesId?: string;
  index?: number;
  total?: number;
}

export interface RunRecordChild {
  runId: string;
  taskId: string;
  index: number;
  status: RunRecordStatus;
  outcome?: RunRecordOutcome;
}

export interface RunRecordObservability {
  enabled: boolean;
  backend: "daytona-volume" | "disabled";
  volumeName: string;
  mountPath: string;
  runRoot?: string;
}

export interface RunRecordEvent {
  at: string;
  event: string;
  data: unknown;
}

export interface RunRecordAttempt {
  attempt: number;
  claudeSessionId?: string;
  resumedFromSessionId?: string;
  claudeConfigDir?: string;
  claudeStreamPath?: string;
  claudeStreamBytes?: number;
  claudeLastEventType?: string;
  claudeLastTool?: string;
  claudeLastActivityAt?: string;
  commandLastHeartbeatAt?: string;
  commandLastHeartbeatElapsedMs?: number;
  agentSandboxId?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  gateSandboxIds: string[];
  gateOutcome?: string;
}

export interface RunRecordV2 {
  schemaVersion: 2;
  runId: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  driver: string;
  status: RunRecordStatus;
  observability: RunRecordObservability;
  attempts: RunRecordAttempt[];
  attemptCount?: number;
  events: RunRecordEvent[];
  outcome?: RunOutcome["outcome"];
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  errorReason?: string;
}

export interface RunRecordV3 {
  schemaVersion: 3;
  runId: string;
  kind: RunRecordKind;
  parentRunId?: string;
  createdAt: string;
  updatedAt: string;
  repo: RunRecordRepo;
  task: RunRecordTask;
  driver: string;
  status: RunRecordStatus;
  observability: RunRecordObservability;
  selectedContracts: string[];
  attempts: RunRecordAttempt[];
  attemptCount?: number;
  events: RunRecordEvent[];
  children?: RunRecordChild[];
  logs?: string[];
  report?: GateReport;
  publication?: PublicationResult;
  outcome?: RunRecordOutcome;
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  errorReason?: string;
}

export interface CreateRunRecorderInput {
  runId: string;
  createdAt?: string;
  kind?: RunRecordKind;
  parentRunId?: string;
  task: string;
  taskId?: string;
  seriesId?: string;
  taskIndex?: number;
  taskTotal?: number;
  driver: string;
  observability: RunRecordObservability;
  selectedContracts?: string[];
  repo?: RunRecordRepo;
}

export interface CompleteRunRecordInput {
  outcome: RunRecordOutcome;
  attempts: number;
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  report?: GateReport;
  logs?: string[];
  publication?: PublicationResult;
}

export interface FailRunRecordInput {
  outcome?: RunRecordOutcome;
  attempts?: number;
  summary?: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
  report?: GateReport;
  logs?: string[];
  publication?: PublicationResult;
}

export interface RunStoreStartInput {
  runId?: string;
  kind: RunRecordKind;
  parentRunId?: string;
  task: RunRecordTask;
  driver: string;
  observability: RunRecordObservability;
  selectedContracts?: string[];
}

export interface RunStoreOptions {
  now?: () => string;
  makeRunId?: () => string;
  repoInfo?: () => RunRecordRepo;
}

export interface ListRunsFilter {
  kind?: RunRecordKind;
  taskId?: string;
  seriesId?: string;
  parentRunId?: string;
}

function defaultRunId(now = new Date(), randomId = randomUUID): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = randomId().replaceAll("-", "").replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8);
  if (suffix.length < 8) {
    throw new Error("random id must contain at least 8 safe characters");
  }
  return `${stamp}-${suffix}`;
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function defaultRepoInfo(cwd: string): RunRecordRepo {
  const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) return { root: cwd };
  const branch = runGit(cwd, ["branch", "--show-current"]);
  const head = runGit(cwd, ["rev-parse", "HEAD"]);
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    root: cwd,
    gitRoot,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  };
}

function isRunOutcome(value: unknown): value is RunOutcome["outcome"] {
  return value === "ready_for_mr" ||
    value === "blocked" ||
    value === "escalated";
}

function isRunRecordOutcome(value: unknown): value is RunRecordOutcome {
  return isRunOutcome(value) || value === "completed" || value === "error";
}

function isSummary(value: unknown): value is RunOutcome["report"]["summary"] {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return ["total", "pass", "fail", "error", "needsReview"].every(
    (key) => Number.isSafeInteger(summary[key]),
  );
}

function isValidTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidAttemptCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRunRecordRepo(value: unknown): value is RunRecordRepo {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.root === "string" &&
    isOptionalString(value.gitRoot) &&
    isOptionalString(value.branch) &&
    isOptionalString(value.head) &&
    (value.dirty === undefined || typeof value.dirty === "boolean")
  );
}

function isRunRecordTask(value: unknown): value is RunRecordTask {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.description === "string" &&
    isOptionalString(value.taskId) &&
    isOptionalString(value.seriesId) &&
    (value.index === undefined || isPositiveSafeInteger(value.index)) &&
    (value.total === undefined || isPositiveSafeInteger(value.total))
  );
}

function isRunRecordChild(value: unknown): value is RunRecordChild {
  if (!isPlainObject(value)) return false;
  return (
    isSafeRunId(value.runId) &&
    typeof value.taskId === "string" &&
    isPositiveSafeInteger(value.index) &&
    (value.status === "running" || value.status === "completed" || value.status === "error") &&
    (value.outcome === undefined || isRunRecordOutcome(value.outcome))
  );
}

function kindMetadataError(record: Pick<RunRecordV3, "kind" | "parentRunId" | "task">): string | undefined {
  if (record.kind === "single") {
    return record.parentRunId === undefined
      ? undefined
      : "single run record must not have parentRunId";
  }
  if (record.kind === "series") {
    if (record.parentRunId !== undefined) return "series run record must not have parentRunId";
    if (typeof record.task.seriesId !== "string") return "series run record requires seriesId";
    if (!isPositiveSafeInteger(record.task.total)) return "series run record requires total";
    return undefined;
  }
  if (!isSafeRunId(record.parentRunId)) return "series-task run record requires parentRunId";
  if (typeof record.task.taskId !== "string") return "series-task run record requires taskId";
  if (typeof record.task.seriesId !== "string") return "series-task run record requires seriesId";
  if (!isPositiveSafeInteger(record.task.index)) return "series-task run record requires index";
  if (!isPositiveSafeInteger(record.task.total)) return "series-task run record requires total";
  return undefined;
}

function isRunRecordEvent(value: unknown): value is RunRecordEvent {
  if (!isPlainObject(value)) return false;
  return isValidTimestamp(value.at) && typeof value.event === "string";
}

function isRunRecordAttempt(value: unknown): value is RunRecordAttempt {
  if (!isPlainObject(value)) return false;
  return (
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0 &&
    isOptionalString(value.claudeSessionId) &&
    isOptionalString(value.resumedFromSessionId) &&
    isOptionalString(value.claudeConfigDir) &&
    isOptionalString(value.claudeStreamPath) &&
    (
      value.commandLastHeartbeatAt === undefined ||
      (
        typeof value.commandLastHeartbeatAt === "string" &&
        isValidTimestamp(value.commandLastHeartbeatAt)
      )
    ) &&
    (
      value.commandLastHeartbeatElapsedMs === undefined ||
      isNonNegativeSafeInteger(value.commandLastHeartbeatElapsedMs)
    ) &&
    isOptionalString(value.agentSandboxId) &&
    (
      value.startedAt === undefined ||
      (typeof value.startedAt === "string" && isValidTimestamp(value.startedAt))
    ) &&
    (
      value.endedAt === undefined ||
      (typeof value.endedAt === "string" && isValidTimestamp(value.endedAt))
    ) &&
    (
      value.exitCode === undefined ||
      Number.isSafeInteger(value.exitCode)
    ) &&
    isStringArray(value.gateSandboxIds) &&
    isOptionalString(value.gateOutcome)
  );
}

function isGateReport(value: unknown): value is GateReport {
  if (!isPlainObject(value)) return false;
  return (
    (value.outcome === "pass" || value.outcome === "fail" || value.outcome === "blocked") &&
    Array.isArray(value.results) &&
    isSummary(value.summary) &&
    Array.isArray(value.pendingDecisions) &&
    Number.isSafeInteger(value.exitCode)
  );
}

function isPublicationResult(value: unknown): value is PublicationResult {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    isStringArray(value.changedFiles) &&
    isOptionalString(value.conflict)
  );
}

function isRunRecordObservability(
  value: unknown,
): value is RunRecordObservability {
  if (typeof value !== "object" || value === null) return false;
  const observability = value as Record<string, unknown>;
  return (
    typeof observability.enabled === "boolean" &&
    (
      observability.backend === "daytona-volume" ||
      observability.backend === "disabled"
    ) &&
    typeof observability.volumeName === "string" &&
    typeof observability.mountPath === "string" &&
    (
      observability.runRoot === undefined ||
      typeof observability.runRoot === "string"
    )
  );
}

function isSafeRunId(runId: unknown): runId is string {
  if (typeof runId !== "string") return false;
  try {
    assertSafeRunId(runId);
    return true;
  } catch {
    return false;
  }
}

export function writeRunRecord(cwd: string, rec: RunRecord): string {
  mkdirSync(runsDir(cwd), { recursive: true });
  const name = `${rec.at.replace(/[:.]/g, "-")}.json`;
  const path = join(runsDir(cwd), name);
  writeFileSync(path, JSON.stringify(rec, null, 2), "utf8");
  return path;
}

export class RunRecorder {
  readonly path: string;
  private readonly record: RunRecordV3;
  private readonly now: () => string;

  constructor(
    cwd: string,
    input: CreateRunRecorderInput,
    now = () => new Date().toISOString(),
  ) {
    mkdirSync(runsDir(cwd), { recursive: true });
    const createdAt = input.createdAt ?? now();
    assertSafeRunId(input.runId);
    this.path = join(runsDir(cwd), `${input.runId}.json`);
    this.now = now;
    this.record = {
      schemaVersion: 3,
      runId: input.runId,
      kind: input.kind ?? "single",
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      createdAt,
      updatedAt: createdAt,
      repo: input.repo ?? defaultRepoInfo(cwd),
      task: {
        description: input.task,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.seriesId ? { seriesId: input.seriesId } : {}),
        ...(input.taskIndex !== undefined ? { index: input.taskIndex } : {}),
        ...(input.taskTotal !== undefined ? { total: input.taskTotal } : {}),
      },
      driver: input.driver,
      status: "running",
      observability: input.observability,
      selectedContracts: input.selectedContracts ?? [],
      attempts: [],
      events: [],
    };
    const metadataError = kindMetadataError(this.record);
    if (metadataError) throw new Error(metadataError);
    this.recordEvent("run.record.created", { runId: input.runId });
  }

  recordEvent(event: string, data: unknown): void {
    const snapshot = snapshotJsonValue(data);
    this.applyEvent(event, snapshot);
    this.record.events.push({ at: this.now(), event, data: snapshot });
    this.write();
  }

  setObservability(observability: RunRecordObservability): void {
    this.record.observability = snapshotJsonValue(
      observability,
    ) as RunRecordObservability;
    this.write();
  }

  setSelectedContracts(ids: string[]): void {
    this.record.selectedContracts = [...ids];
    this.write();
  }

  setChildren(children: RunRecordChild[]): void {
    this.record.children = children.map((child) => ({ ...child }));
    this.write();
  }

  complete(input: CompleteRunRecordInput): void {
    this.record.status = "completed";
    this.record.outcome = input.outcome;
    this.record.attemptCount = input.attempts;
    this.applyCompletionDetails(input);
    this.write();
  }

  fail(error: unknown, input: FailRunRecordInput = {}): void {
    this.record.status = "error";
    this.record.errorReason = error instanceof Error ? error.message : String(error);
    this.record.outcome = input.outcome ?? "error";
    if (input.attempts !== undefined) this.record.attemptCount = input.attempts;
    this.applyCompletionDetails(input);
    this.write();
  }

  private applyCompletionDetails(input: FailRunRecordInput): void {
    if (input.summary) {
      this.record.summary = snapshotJsonValue(
        input.summary,
      ) as RunOutcome["report"]["summary"];
    }
    if (input.action) {
      this.record.action = snapshotJsonValue(
        input.action,
      ) as RunOutcome["action"];
    }
    if (input.report) {
      this.record.report = snapshotJsonValue(input.report) as GateReport;
    }
    if (input.logs) {
      this.record.logs = snapshotJsonValue(input.logs) as string[];
    }
    if (input.publication) {
      this.record.publication = snapshotJsonValue(input.publication) as PublicationResult;
    }
  }

  private attempt(number: number): RunRecordAttempt {
    let attempt = this.record.attempts.find((item) => item.attempt === number);
    if (!attempt) {
      attempt = { attempt: number, gateSandboxIds: [] };
      this.record.attempts.push(attempt);
    }
    return attempt;
  }

  private applyEvent(event: string, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const value = data as Record<string, unknown>;
    const attemptNumber = value.attempt;
    if (!Number.isSafeInteger(attemptNumber) || Number(attemptNumber) <= 0) {
      return;
    }
    if (
      event !== "agent.command.start" &&
      event !== "agent.command.end" &&
      event !== "agent.command.progress" &&
      event !== "agent.command.heartbeat" &&
      event !== "agent.observability.stream" &&
      event !== "gate.create.end" &&
      event !== "gate.run.end"
    ) {
      return;
    }
    const attempt = this.attempt(Number(attemptNumber));
    if (
      event === "agent.command.start" &&
      value.resume === true &&
      typeof value.claudeSessionId === "string"
    ) {
      attempt.resumedFromSessionId = value.claudeSessionId;
    }
    if (
      event === "agent.command.end" &&
      typeof value.claudeSessionId === "string"
    ) {
      attempt.claudeSessionId = value.claudeSessionId;
    }
    if (event === "agent.command.start") {
      attempt.startedAt = this.now();
      if (typeof value.id === "string") attempt.agentSandboxId = value.id;
      if (typeof value.claudeConfigDir === "string") {
        attempt.claudeConfigDir = value.claudeConfigDir;
      }
      if (typeof value.claudeStreamPath === "string") {
        attempt.claudeStreamPath = value.claudeStreamPath;
      }
    }
    if (event === "agent.command.end") {
      attempt.endedAt = this.now();
      if (typeof value.exitCode === "number") attempt.exitCode = value.exitCode;
    }
    if (
      event === "agent.observability.stream" &&
      typeof value.path === "string"
    ) {
      attempt.claudeStreamPath = value.path;
    }
    if (event === "agent.command.progress") {
      if (typeof value.path === "string") {
        attempt.claudeStreamPath = value.path;
      }
      if (typeof value.bytes === "number") {
        attempt.claudeStreamBytes = value.bytes;
      }
      if (typeof value.lastEventType === "string") {
        attempt.claudeLastEventType = value.lastEventType;
      }
      if (typeof value.lastTool === "string") {
        attempt.claudeLastTool = value.lastTool;
      }
      if (typeof value.lastActivityAt === "string") {
        attempt.claudeLastActivityAt = value.lastActivityAt;
      }
    }
    if (event === "agent.command.heartbeat") {
      if (typeof value.id === "string") attempt.agentSandboxId = value.id;
      if (typeof value.claudeStreamPath === "string") {
        attempt.claudeStreamPath = value.claudeStreamPath;
      }
      if (typeof value.elapsedMs === "number") {
        attempt.commandLastHeartbeatElapsedMs = value.elapsedMs;
      }
      attempt.commandLastHeartbeatAt = this.now();
    }
    if (event === "gate.create.end" && typeof value.id === "string") {
      if (!attempt.gateSandboxIds.includes(value.id)) {
        attempt.gateSandboxIds.push(value.id);
      }
    }
    if (event === "gate.run.end" && typeof value.outcome === "string") {
      attempt.gateOutcome = value.outcome;
    }
  }

  private write(): void {
    this.record.updatedAt = this.now();
    writeFileSync(this.path, JSON.stringify(this.record, null, 2), "utf8");
  }
}

export function createRunRecorder(
  cwd: string,
  input: CreateRunRecorderInput,
  now?: () => string,
): RunRecorder {
  return new RunRecorder(cwd, input, now);
}

function toRunRecordV3(value: unknown): RunRecordV3 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<RunRecordV3>;
  if (
    record.schemaVersion !== 3 ||
    !isSafeRunId(record.runId) ||
    (record.kind !== "single" && record.kind !== "series" && record.kind !== "series-task") ||
    (record.parentRunId !== undefined && !isSafeRunId(record.parentRunId)) ||
    !isValidTimestamp(record.createdAt) ||
    !isValidTimestamp(record.updatedAt) ||
    !isRunRecordRepo(record.repo) ||
    !isRunRecordTask(record.task) ||
    typeof record.driver !== "string" ||
    (record.status !== "running" && record.status !== "completed" && record.status !== "error") ||
    !isRunRecordObservability(record.observability) ||
    !Array.isArray(record.selectedContracts) ||
    !record.selectedContracts.every((item) => typeof item === "string") ||
    !Array.isArray(record.attempts) ||
    !record.attempts.every(isRunRecordAttempt) ||
    !Array.isArray(record.events) ||
    !record.events.every(isRunRecordEvent) ||
    (record.children !== undefined && (
      !Array.isArray(record.children) ||
      !record.children.every(isRunRecordChild)
    )) ||
    (record.logs !== undefined && !isStringArray(record.logs)) ||
    (record.report !== undefined && !isGateReport(record.report)) ||
    (record.publication !== undefined && !isPublicationResult(record.publication)) ||
    (record.outcome !== undefined && !isRunRecordOutcome(record.outcome)) ||
    (record.summary !== undefined && !isSummary(record.summary)) ||
    (record.action !== undefined && !isPlainObject(record.action)) ||
    (record.errorReason !== undefined && typeof record.errorReason !== "string") ||
    (record.attemptCount !== undefined && !isValidAttemptCount(record.attemptCount))
  ) {
    return undefined;
  }
  if (kindMetadataError(record as RunRecordV3)) return undefined;
  return record as RunRecordV3;
}

export class RunStore {
  private readonly cwd: string;
  private readonly now: () => string;
  private readonly makeRunId: () => string;
  private readonly repoInfo: () => RunRecordRepo;

  constructor(cwd: string, options: RunStoreOptions = {}) {
    this.cwd = cwd;
    this.now = options.now ?? (() => new Date().toISOString());
    this.makeRunId = options.makeRunId ?? (() => defaultRunId());
    this.repoInfo = options.repoInfo ?? (() => defaultRepoInfo(cwd));
  }

  startRun(input: RunStoreStartInput): RunRecorder {
    const runId = input.runId ?? this.makeRunId();
    return new RunRecorder(
      this.cwd,
      {
        runId,
        kind: input.kind,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        task: input.task.description,
        ...(input.task.taskId ? { taskId: input.task.taskId } : {}),
        ...(input.task.seriesId ? { seriesId: input.task.seriesId } : {}),
        ...(input.task.index !== undefined ? { taskIndex: input.task.index } : {}),
        ...(input.task.total !== undefined ? { taskTotal: input.task.total } : {}),
        driver: input.driver,
        observability: input.observability,
        selectedContracts: input.selectedContracts ?? [],
        repo: this.repoInfo(),
      },
      this.now,
    );
  }

  readRun(runId: string): RunRecordV3 | undefined {
    assertSafeRunId(runId);
    const path = join(runsDir(this.cwd), `${runId}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return toRunRecordV3(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  listRuns(filter: ListRunsFilter = {}): RunRecordV3[] {
    const d = runsDir(this.cwd);
    if (!existsSync(d)) return [];
    const runs: RunRecordV3[] = [];
    for (const file of readdirSync(d).filter((item) => item.endsWith(".json"))) {
      try {
        const run = toRunRecordV3(
          JSON.parse(readFileSync(join(d, file), "utf8")),
        );
        if (!run) continue;
        if (filter.kind && run.kind !== filter.kind) continue;
        if (filter.taskId && run.task.taskId !== filter.taskId) continue;
        if (filter.seriesId && run.task.seriesId !== filter.seriesId) continue;
        if (filter.parentRunId && run.parentRunId !== filter.parentRunId) continue;
        runs.push(run);
      } catch {
        continue;
      }
    }
    return runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

function toLastRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v3 = toRunRecordV3(value);
  if (v3) {
    if (
      v3.status !== "completed" ||
      !isRunOutcome(v3.outcome) ||
      !isSummary(v3.summary)
    ) {
      return undefined;
    }
    if (
      v3.attemptCount !== undefined &&
      !isValidAttemptCount(v3.attemptCount)
    ) {
      return undefined;
    }
    return {
      at: v3.createdAt,
      task: v3.task.description,
      driver: v3.driver,
      outcome: v3.outcome,
      attempts: v3.attemptCount ?? v3.attempts.length,
      summary: v3.summary,
      ...(v3.action ? { action: v3.action } : {}),
    };
  }

  const record = value as Partial<RunRecordV2 & RunRecord>;
  if (record.schemaVersion === 2) {
    if (
      record.status !== "completed" ||
      !isSafeRunId(record.runId) ||
      !isValidTimestamp(record.createdAt) ||
      !isValidTimestamp(record.updatedAt) ||
      typeof record.task !== "string" ||
      typeof record.driver !== "string" ||
      !isRunRecordObservability(record.observability) ||
      !Array.isArray(record.attempts) ||
      !Array.isArray(record.events) ||
      !isRunOutcome(record.outcome) ||
      !isSummary(record.summary)
    ) {
      return undefined;
    }
    if (
      record.attemptCount !== undefined &&
      !isValidAttemptCount(record.attemptCount)
    ) {
      return undefined;
    }
    const attempts = record.attemptCount ?? (
      record.attempts.length
    );
    return {
      at: record.createdAt,
      task: record.task,
      driver: record.driver,
      outcome: record.outcome,
      attempts,
      summary: record.summary,
      ...(record.action ? { action: record.action } : {}),
    };
  }
  if (
    record.schemaVersion === undefined &&
    isValidTimestamp(record.at) &&
    typeof record.task === "string" &&
    typeof record.driver === "string" &&
    isRunOutcome(record.outcome) &&
    isValidAttemptCount(record.attempts) &&
    isSummary(record.summary)
  ) {
    return record as RunRecord;
  }
  return undefined;
}

export function lastRunRecord(cwd: string): RunRecord | undefined {
  const d = runsDir(cwd);
  if (!existsSync(d)) return undefined;
  const files = readdirSync(d).filter((f) => f.endsWith(".json")).sort();
  let last: RunRecord | undefined;
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index]!;
    try {
      const record = toLastRunRecord(
        JSON.parse(readFileSync(join(d, file), "utf8")),
      );
      if (
        record &&
        (!last || Date.parse(record.at) >= Date.parse(last.at))
      ) {
        last = record;
      }
    } catch {
      continue;
    }
  }
  return last;
}

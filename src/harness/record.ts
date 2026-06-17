import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "./run.js";

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

export interface CreateRunRecorderInput {
  runId: string;
  createdAt?: string;
  task: string;
  driver: string;
  observability: RunRecordObservability;
}

export interface CompleteRunRecordInput {
  outcome: RunOutcome["outcome"];
  attempts: number;
  summary: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
}

function isRunOutcome(value: unknown): value is RunOutcome["outcome"] {
  return value === "ready_for_mr" ||
    value === "blocked" ||
    value === "escalated";
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
  private readonly record: RunRecordV2;
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
      schemaVersion: 2,
      runId: input.runId,
      createdAt,
      updatedAt: createdAt,
      task: input.task,
      driver: input.driver,
      status: "running",
      observability: input.observability,
      attempts: [],
      events: [],
    };
    this.recordEvent("run.record.created", { runId: input.runId });
  }

  recordEvent(event: string, data: unknown): void {
    const snapshot = snapshotJsonValue(data);
    this.applyEvent(event, snapshot);
    this.record.events.push({ at: this.now(), event, data: snapshot });
    this.write();
  }

  complete(input: CompleteRunRecordInput): void {
    this.record.status = "completed";
    this.record.outcome = input.outcome;
    this.record.attemptCount = input.attempts;
    this.record.summary = snapshotJsonValue(
      input.summary,
    ) as RunOutcome["report"]["summary"];
    if (input.action) {
      this.record.action = snapshotJsonValue(
        input.action,
      ) as RunOutcome["action"];
    }
    this.write();
  }

  fail(error: unknown): void {
    this.record.status = "error";
    this.record.errorReason = error instanceof Error ? error.message : String(error);
    this.write();
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
    }
    if (event === "agent.command.end") {
      attempt.endedAt = this.now();
      if (typeof value.exitCode === "number") attempt.exitCode = value.exitCode;
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
): RunRecorder {
  return new RunRecorder(cwd, input);
}

function toLastRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
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

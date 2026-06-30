import type { RunRecordAttempt, RunRecordKind, RunRecordV3 } from "./record.js";

export interface CurrentRepoState {
  head?: string;
  dirty?: boolean;
}

export interface RetainedRunResumeRequest {
  task: string;
  selectedContracts: string[];
  agentSandboxId: string;
  claudeSessionId?: string;
  claudeStreamPath?: string;
  recoverCompletedCommand?: boolean;
  completedAttempts: number;
  sourceRunId: string;
  sourceKind: RunRecordKind;
}

function isResumeEligibleRecord(record: RunRecordV3): boolean {
  return (
    (record.status === "completed" && record.outcome === "escalated") ||
    (record.status === "running" && record.outcome === undefined)
  );
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function eventDataHasDeletedSandbox(data: unknown, agentSandboxId: string): boolean {
  if (typeof data !== "object" || data === null) return false;
  const fields = data as { id?: unknown; outcome?: unknown };
  return fields.id === agentSandboxId && fields.outcome === "deleted";
}

function assertValidAttemptNumber(attempt: RunRecordAttempt): void {
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
    throw new Error("resume source attempt metadata must include a safe integer attempt >= 1");
  }
}

function latestAttemptWithSandbox(attempts: RunRecordAttempt[]): RunRecordAttempt | undefined {
  let latest: RunRecordAttempt | undefined;
  for (const attempt of attempts) {
    assertValidAttemptNumber(attempt);
    if (!hasString(attempt.agentSandboxId)) continue;
    if (latest === undefined || attempt.attempt > latest.attempt) {
      latest = attempt;
    }
  }
  return latest;
}

export function buildRetainedRunResumeRequest(
  record: RunRecordV3,
  current: CurrentRepoState,
): RetainedRunResumeRequest {
  if (record.driver !== "daytona(claude)") {
    throw new Error("resume requires a daytona(claude) source record");
  }
  if (!isResumeEligibleRecord(record)) {
    throw new Error("resume source must be completed with outcome escalated or an interrupted running record");
  }
  if (record.repo.dirty === true) {
    throw new Error("resume source repo was dirty");
  }
  if (current.dirty === true) {
    throw new Error("resume current repo is dirty");
  }
  if (
    hasString(record.repo.head) &&
    hasString(current.head) &&
    record.repo.head !== current.head
  ) {
    throw new Error("resume current HEAD does not match source HEAD");
  }
  if (record.selectedContracts.length === 0) {
    throw new Error("resume source selectedContracts must not be empty");
  }

  const attempt = latestAttemptWithSandbox(record.attempts);
  if (attempt === undefined || !hasString(attempt.agentSandboxId)) {
    throw new Error("resume source has no attempt with agentSandboxId");
  }
  const agentSandboxId = attempt.agentSandboxId;

  const cleanupDeleted = record.events.some((event) =>
    event.event === "agent.cleanup.end" &&
    eventDataHasDeletedSandbox(event.data, agentSandboxId),
  );
  if (cleanupDeleted) {
    throw new Error("resume source retained sandbox was deleted");
  }

  const claudeSessionId = hasString(attempt.claudeSessionId)
    ? attempt.claudeSessionId
    : undefined;
  const claudeStreamPath = hasString(attempt.claudeStreamPath)
    ? attempt.claudeStreamPath
    : undefined;
  if (claudeSessionId === undefined && claudeStreamPath === undefined) {
    throw new Error("resume source attempt must include claudeSessionId or claudeStreamPath");
  }

  return {
    task: record.task.description,
    selectedContracts: [...record.selectedContracts],
    agentSandboxId,
    ...(claudeSessionId === undefined ? {} : { claudeSessionId }),
    ...(claudeStreamPath === undefined ? {} : { claudeStreamPath }),
    ...(claudeSessionId === undefined && claudeStreamPath !== undefined
      ? { recoverCompletedCommand: true }
      : {}),
    completedAttempts: attempt.attempt,
    sourceRunId: record.runId,
    sourceKind: record.kind,
  };
}

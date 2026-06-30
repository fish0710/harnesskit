import type { RunRecordAttempt, RunRecordKind, RunRecordV3 } from "./record.js";

export interface CurrentRepoState {
  head?: string;
  dirty?: boolean;
  changedPaths?: string[];
}

export interface RetainedRunResumeOptions {
  allowHarnessDirtySource?: boolean;
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
  allowedSourceDirtyPaths?: string[];
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
    throw new Error("source run attempt metadata is invalid");
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

function pathIsOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isHarnessOwnedDirtyPath(path: string): boolean {
  return (
    pathIsOrUnder(path, ".harness") ||
    pathIsOrUnder(path, "contracts") ||
    pathIsOrUnder(path, "test/gates") ||
    pathIsOrUnder(path, ".github/workflows") ||
    pathIsOrUnder(path, "docs/specs") ||
    pathIsOrUnder(path, "docs/plans") ||
    pathIsOrUnder(path, "docs/reference") ||
    pathIsOrUnder(path, "docs/decisions") ||
    path === "harness.config.json" ||
    path === "CODEOWNERS" ||
    path === "AGENTS.md"
  );
}

function validateHarnessDirtySourceOverride(current: CurrentRepoState): string[] {
  if (!current.changedPaths) {
    throw new Error("current dirty paths could not be read; retained dirty-source resume requires path-level validation");
  }
  if (current.changedPaths.length === 0) {
    throw new Error("current dirty paths are empty; retained dirty-source resume cannot verify the source dirty state");
  }
  const disallowed = current.changedPaths.filter((path) =>
    !isHarnessOwnedDirtyPath(path)
  );
  if (disallowed.length > 0) {
    throw new Error(
      `current worktree has non-Harness source changes; retained dirty-source resume is not safe: ${disallowed.join(", ")}`,
    );
  }
  return [...current.changedPaths];
}

export function buildRetainedRunResumeRequest(
  record: RunRecordV3,
  current: CurrentRepoState,
  options: RetainedRunResumeOptions = {},
): RetainedRunResumeRequest {
  if (record.driver !== "daytona(claude)") {
    throw new Error("only daytona(claude) runs can be resumed");
  }
  if (!isResumeEligibleRecord(record)) {
    throw new Error("only escalated or interrupted running Claude runs can be resumed");
  }
  const allowHarnessDirtySource = options.allowHarnessDirtySource === true;
  if (record.repo.dirty === true && !allowHarnessDirtySource) {
    throw new Error("source run started from a dirty worktree; retained resume cannot reconstruct its baseline safely");
  }
  if (record.repo.dirty !== true && record.repo.dirty !== false) {
    throw new Error("source run did not record clean/dirty state; retained resume cannot reconstruct its baseline safely");
  }
  if (!hasString(record.repo.head)) {
    throw new Error("source run did not record a Git HEAD; retained resume cannot reconstruct its baseline safely");
  }
  if (!hasString(current.head)) {
    throw new Error("current Git HEAD could not be read; retained resume requires a matching baseline");
  }
  if (record.repo.head !== current.head) {
    throw new Error(`current HEAD ${current.head} does not match source run HEAD ${record.repo.head}`);
  }
  const allowedSourceDirtyPaths = record.repo.dirty === true
    ? validateHarnessDirtySourceOverride(current)
    : undefined;
  if (current.dirty === true && allowedSourceDirtyPaths === undefined) {
    throw new Error("current worktree has source changes; commit, stash, or revert them before retained resume");
  }
  if (current.dirty !== false && allowedSourceDirtyPaths === undefined) {
    throw new Error("current worktree clean/dirty state could not be read; retained resume requires a clean baseline");
  }
  if (record.selectedContracts.length === 0) {
    throw new Error("source run did not record selected contracts; retained resume cannot safely select Gate contracts");
  }

  const attempt = latestAttemptWithSandbox(record.attempts);
  if (attempt === undefined || !hasString(attempt.agentSandboxId)) {
    throw new Error("source run did not record an Agent sandbox id");
  }
  const agentSandboxId = attempt.agentSandboxId;

  const cleanupDeleted = record.events.some((event) =>
    event.event === "agent.cleanup.end" &&
    eventDataHasDeletedSandbox(event.data, agentSandboxId),
  );
  if (cleanupDeleted) {
    throw new Error(`agent sandbox ${agentSandboxId} was deleted`);
  }

  const claudeSessionId = hasString(attempt.claudeSessionId)
    ? attempt.claudeSessionId
    : undefined;
  const claudeStreamPath = hasString(attempt.claudeStreamPath)
    ? attempt.claudeStreamPath
    : undefined;
  if (claudeSessionId === undefined && claudeStreamPath === undefined) {
    throw new Error("source run did not record a Claude session id or stream path");
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
    ...(allowedSourceDirtyPaths === undefined
      ? {}
      : { allowedSourceDirtyPaths }),
  };
}

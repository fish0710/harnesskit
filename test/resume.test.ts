import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRetainedRunResumeRequest } from "../src/harness/resume.js";
import type { RunRecordAttempt, RunRecordV3 } from "../src/harness/record.js";

const baseAttempt: RunRecordAttempt = {
  attempt: 1,
  agentSandboxId: "sandbox-1",
  claudeSessionId: "session-1",
  gateSandboxIds: [],
};

function runRecord(overrides: Partial<RunRecordV3> = {}): RunRecordV3 {
  return {
    schemaVersion: 3,
    runId: "run-1",
    kind: "single",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:01:00.000Z",
    repo: {
      root: "/repo",
      gitRoot: "/repo",
      branch: "main",
      head: "head-1",
      dirty: false,
    },
    task: {
      description: "resume retained sandbox",
    },
    driver: "daytona(claude)",
    status: "completed",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["smoke.boot"],
    attempts: [baseAttempt],
    events: [],
    outcome: "escalated",
    ...overrides,
  };
}

function assertResumeError(
  record: RunRecordV3,
  current: { head?: string; dirty?: boolean; changedPaths?: string[] },
  message: string,
  options?: Parameters<typeof buildRetainedRunResumeRequest>[2],
): void {
  assert.throws(
    () => buildRetainedRunResumeRequest(record, current, options),
    (error: unknown) => error instanceof Error && error.message === message,
  );
}

test("accepts retained escalated Claude runs with claudeSessionId", () => {
  const request = buildRetainedRunResumeRequest(
    runRecord({
      runId: "source-run",
      kind: "series-task",
      parentRunId: "series-run",
      task: {
        description: "finish task",
        taskId: "task-1",
        seriesId: "series-1",
        index: 1,
        total: 2,
      },
      selectedContracts: ["contract.a", "contract.b"],
      attempts: [
        {
          ...baseAttempt,
          attempt: 2,
          agentSandboxId: "sandbox-2",
          claudeSessionId: "session-2",
          claudeStreamPath: "/obs/run/attempt-2.jsonl",
        },
      ],
    }),
    { head: "head-1", dirty: false },
  );

  assert.deepEqual(request, {
    task: "finish task",
    selectedContracts: ["contract.a", "contract.b"],
    agentSandboxId: "sandbox-2",
    claudeSessionId: "session-2",
    claudeStreamPath: "/obs/run/attempt-2.jsonl",
    completedAttempts: 2,
    sourceRunId: "source-run",
    sourceKind: "series-task",
  });
});

test("accepts interrupted running Claude runs with stream path and marks command recovery", () => {
  const request = buildRetainedRunResumeRequest(
    runRecord({
      status: "running",
      outcome: undefined,
      attempts: [
        {
          attempt: 1,
          agentSandboxId: "sandbox-running",
          claudeStreamPath: "/obs/run/attempt-1.jsonl",
          gateSandboxIds: [],
        },
      ],
    }),
    { head: "head-1", dirty: false },
  );

  assert.deepEqual(request, {
    task: "resume retained sandbox",
    selectedContracts: ["smoke.boot"],
    agentSandboxId: "sandbox-running",
    claudeStreamPath: "/obs/run/attempt-1.jsonl",
    recoverCompletedCommand: true,
    completedAttempts: 1,
    sourceRunId: "run-1",
    sourceKind: "single",
  });
});

test("rejects deleted retained sandboxes based on cleanup event", () => {
  assertResumeError(
    runRecord({
      attempts: [
        {
          ...baseAttempt,
          agentSandboxId: "sandbox-deleted",
        },
      ],
      events: [
        {
          at: "2026-06-30T00:02:00.000Z",
          event: "agent.cleanup.end",
          data: {
            id: "sandbox-deleted",
            outcome: "deleted",
          },
        },
      ],
    }),
    { head: "head-1", dirty: false },
    "agent sandbox sandbox-deleted was deleted",
  );
});

test("rejects current HEAD mismatch", () => {
  assertResumeError(
    runRecord(),
    { head: "head-2", dirty: false },
    "current HEAD head-2 does not match source run HEAD head-1",
  );
});

test("rejects HEAD mismatch before current dirty worktrees", () => {
  assertResumeError(
    runRecord(),
    { head: "head-2", dirty: true },
    "current HEAD head-2 does not match source run HEAD head-1",
  );
});

test("rejects source dirty repositories", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
        dirty: true,
      },
    }),
    { head: "head-1", dirty: false },
    "source run started from a dirty worktree; retained resume cannot reconstruct its baseline safely",
  );
});

test("accepts source dirty repositories with explicit Harness-only dirty override", () => {
  const request = buildRetainedRunResumeRequest(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
        dirty: true,
      },
    }),
    {
      head: "head-1",
      dirty: true,
      changedPaths: [
        ".harness/runs/source.json",
        "contracts/gate-a.yaml",
        "test/gates/vue3-parity.js",
        "harness.config.json",
        ".github/workflows/harness-gate.yml",
        "CODEOWNERS",
        "AGENTS.md",
        "docs/specs/vue3.md",
        "docs/plans/vue3.md",
        "docs/reference/runtime.md",
      ],
    },
    { allowHarnessDirtySource: true },
  );

  assert.deepEqual(request.allowedSourceDirtyPaths, [
    ".harness/runs/source.json",
    "contracts/gate-a.yaml",
    "test/gates/vue3-parity.js",
    "harness.config.json",
    ".github/workflows/harness-gate.yml",
    "CODEOWNERS",
    "AGENTS.md",
    "docs/specs/vue3.md",
    "docs/plans/vue3.md",
    "docs/reference/runtime.md",
  ]);
});

test("rejects dirty-source override when current dirty paths include product source", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
        dirty: true,
      },
    }),
    {
      head: "head-1",
      dirty: true,
      changedPaths: ["contracts/gate-a.yaml", "src/app.ts"],
    },
    "current worktree has non-Harness source changes; retained dirty-source resume is not safe: src/app.ts",
    { allowHarnessDirtySource: true },
  );
});

test("rejects dirty-source override when current dirty paths are unavailable", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
        dirty: true,
      },
    }),
    { head: "head-1", dirty: true },
    "current dirty paths could not be read; retained dirty-source resume requires path-level validation",
    { allowHarnessDirtySource: true },
  );
});

test("rejects dirty-source override when current dirty paths are empty", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
        dirty: true,
      },
    }),
    { head: "head-1", dirty: false, changedPaths: [] },
    "current dirty paths are empty; retained dirty-source resume cannot verify the source dirty state",
    { allowHarnessDirtySource: true },
  );
});

test("rejects source runs without a recorded clean dirty state", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        head: "head-1",
      },
    }),
    { head: "head-1", dirty: false },
    "source run did not record clean/dirty state; retained resume cannot reconstruct its baseline safely",
  );
});

test("rejects source runs without a recorded Git HEAD", () => {
  assertResumeError(
    runRecord({
      repo: {
        root: "/repo",
        dirty: false,
      },
    }),
    { head: "head-1", dirty: false },
    "source run did not record a Git HEAD; retained resume cannot reconstruct its baseline safely",
  );
});

test("rejects current repositories without a readable Git HEAD", () => {
  assertResumeError(
    runRecord(),
    { dirty: false },
    "current Git HEAD could not be read; retained resume requires a matching baseline",
  );
});

test("rejects current dirty worktrees", () => {
  assertResumeError(
    runRecord(),
    { head: "head-1", dirty: true },
    "current worktree has source changes; commit, stash, or revert them before retained resume",
  );
});

test("rejects current repositories without a known clean dirty state", () => {
  assertResumeError(
    runRecord(),
    { head: "head-1" },
    "current worktree clean/dirty state could not be read; retained resume requires a clean baseline",
  );
});

test("rejects non-Claude daytona command driver", () => {
  assertResumeError(
    runRecord({ driver: "daytona(command)" }),
    { head: "head-1", dirty: false },
    "only daytona(claude) runs can be resumed",
  );
});

test("rejects completed non-escalated outcomes", () => {
  assertResumeError(
    runRecord({ outcome: "ready_for_mr" }),
    { head: "head-1", dirty: false },
    "only escalated or interrupted running Claude runs can be resumed",
  );
});

test("rejects empty selectedContracts", () => {
  assertResumeError(
    runRecord({ selectedContracts: [] }),
    { head: "head-1", dirty: false },
    "source run did not record selected contracts; retained resume cannot safely select Gate contracts",
  );
});

test("selects latest attempt with sandbox over earlier attempt", () => {
  const request = buildRetainedRunResumeRequest(
    runRecord({
      attempts: [
        {
          attempt: 1,
          agentSandboxId: "sandbox-1",
          claudeSessionId: "session-1",
          gateSandboxIds: [],
        },
        {
          attempt: 3,
          claudeSessionId: "session-no-sandbox",
          gateSandboxIds: [],
        },
        {
          attempt: 2,
          agentSandboxId: "sandbox-2",
          claudeSessionId: "session-2",
          gateSandboxIds: [],
        },
      ],
    }),
    { head: "head-1", dirty: false },
  );

  assert.equal(request.agentSandboxId, "sandbox-2");
  assert.equal(request.claudeSessionId, "session-2");
  assert.equal(request.completedAttempts, 2);
});

test("rejects attempts without retained sandbox ids", () => {
  assertResumeError(
    runRecord({
      attempts: [
        {
          attempt: 1,
          claudeSessionId: "session-1",
          gateSandboxIds: [],
        },
      ],
    }),
    { head: "head-1", dirty: false },
    "source run did not record an Agent sandbox id",
  );
});

test("rejects missing Claude session and stream metadata", () => {
  assertResumeError(
    runRecord({
      attempts: [
        {
          attempt: 1,
          agentSandboxId: "sandbox-1",
          gateSandboxIds: [],
        },
      ],
    }),
    { head: "head-1", dirty: false },
    "source run did not record a Claude session id or stream path",
  );
});

test("rejects invalid attempt numbers", () => {
  assertResumeError(
    runRecord({
      attempts: [
        {
          attempt: 0,
          agentSandboxId: "sandbox-0",
          claudeSessionId: "session-0",
          gateSandboxIds: [],
        } as RunRecordAttempt,
      ],
    }),
    { head: "head-1", dirty: false },
    "source run attempt metadata is invalid",
  );
});

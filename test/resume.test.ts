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
  assert.throws(
    () => buildRetainedRunResumeRequest(
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
    ),
    /deleted/,
  );
});

test("rejects current HEAD mismatch", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord(),
      { head: "head-2", dirty: false },
    ),
    /HEAD/,
  );
});

test("rejects source dirty repositories", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord({
        repo: {
          root: "/repo",
          head: "head-1",
          dirty: true,
        },
      }),
      { head: "head-1", dirty: false },
    ),
    /source.*dirty/,
  );
});

test("rejects current dirty worktrees", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord(),
      { head: "head-1", dirty: true },
    ),
    /current.*dirty/,
  );
});

test("rejects non-Claude daytona command driver", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord({ driver: "daytona(command)" }),
      { head: "head-1", dirty: false },
    ),
    /daytona\(claude\)/,
  );
});

test("rejects completed non-escalated outcomes", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord({ outcome: "ready_for_mr" }),
      { head: "head-1", dirty: false },
    ),
    /escalated|running/,
  );
});

test("rejects empty selectedContracts", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
      runRecord({ selectedContracts: [] }),
      { head: "head-1", dirty: false },
    ),
    /selectedContracts/,
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
  assert.throws(
    () => buildRetainedRunResumeRequest(
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
    ),
    /agentSandboxId/,
  );
});

test("rejects missing Claude session and stream metadata", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
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
    ),
    /claudeSessionId|claudeStreamPath/,
  );
});

test("rejects invalid attempt numbers", () => {
  assert.throws(
    () => buildRetainedRunResumeRequest(
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
    ),
    /attempt/,
  );
});

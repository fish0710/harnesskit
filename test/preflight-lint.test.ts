import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate } from "../src/aggregate.js";
import {
  classifyGateReportReadiness,
  lintGateReadiness,
} from "../src/harness/preflight.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import type { CheckResult, Contract } from "../src/types.js";

function policy(gateSetup: string[] = []) {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      gateSetup,
    },
  });
}

function ids(results: Array<{ id: string }>): string[] {
  return results.map((result) => result.id).sort();
}

test("preflight lint rejects bare nvm use in gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["nvm use 14.21.3 && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]?.message ?? "", /source .*nvm\.sh/i);
});

test("preflight lint accepts sourced nvm use in gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 14.21.3 && npm ci'",
    ]),
  });

  assert.deepEqual(
    findings.filter((finding: { severity: string }) => finding.severity === "error"),
    [],
  );
});

test("preflight lint rejects claude in gate setup and contracts", () => {
  const contracts: Contract[] = [
    { id: "agent.leak", type: "command", cmd: "claude", args: ["--version"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["claude --version"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.agent.leak.claude",
    "gateSetup.1.claude",
  ]);
  assert.ok(findings.every((finding: { severity: string }) => finding.severity === "error"));
});

test("preflight lint reports default-missing package managers", () => {
  const contracts: Contract[] = [
    { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
    { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["bun install"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.lint.pnpm.tool",
    "contract.structure.yarn.tool",
    "gateSetup.1.tool",
  ]);
  assert.ok(findings.every((finding: { severity: string }) => finding.severity === "error"));
});

test("preflight lint warns for loopback http without gate setup", () => {
  const findings = lintGateReadiness({
    contracts: [
      {
        id: "api.health",
        type: "http",
        trigger: {
          method: "GET",
          baseUrl: "http://127.0.0.1:3000",
          path: "/health",
        },
        expect: { status: 200 },
      },
    ],
    policy: policy([]),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "contract.api.health.loopback");
  assert.equal(findings[0]?.severity, "warning");
  assert.match(findings[0]?.message ?? "", /gateSetup/i);
});

test("preflight readiness classification promotes command-not-found failures", () => {
  const result: CheckResult = {
    id: "test.unit",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 127，期望 0",
      why: "unit tests",
      how: "stderr:\npnpm: not found",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors.length, 1);
  assert.equal(classified.readinessErrors[0]?.contractId, "test.unit");
  assert.match(classified.readinessErrors[0]?.message ?? "", /pnpm: not found/);
});

test("preflight readiness classification keeps ordinary product failures separate", () => {
  const result: CheckResult = {
    id: "test.unit",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "unit tests",
      how: "stdout:\nexpected health endpoint to return ok",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures, ["test.unit"]);
});

test("preflight readiness classification treats gate errors as readiness errors", () => {
  const result: CheckResult = {
    id: "unknown.type",
    type: "unknown",
    status: "error",
    durationMs: 1,
    violations: [],
    errorReason: "没有注册处理 type",
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.equal(classified.readinessErrors.length, 1);
  assert.equal(classified.readinessErrors[0]?.contractId, "unknown.type");
  assert.match(classified.readinessErrors[0]?.message ?? "", /没有注册处理/);
});

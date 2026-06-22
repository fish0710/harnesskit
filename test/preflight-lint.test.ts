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

test("preflight lint rejects nvm path mentions that do not source nvm", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["echo /usr/local/nvm/nvm.sh && nvm use 20 && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects nvm use before sourcing nvm", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["nvm use 20 && source /usr/local/nvm/nvm.sh && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint accepts dot-sourced nvm before use", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([". /usr/local/nvm/nvm.sh && nvm use 20 && npm ci"]),
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

test("preflight lint rejects path-qualified claude in gate setup and contracts", () => {
  const contracts: Contract[] = [
    { id: "agent.local", type: "command", cmd: "./claude", args: ["--version"] },
    { id: "agent.abs", type: "command", cmd: "/usr/local/bin/claude", args: ["--version"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["/usr/local/bin/claude --version"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.agent.abs.claude",
    "contract.agent.local.claude",
    "gateSetup.1.claude",
  ]);
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

test("preflight lint accepts conservative gate tool bootstraps", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "repo.git", type: "command", cmd: "git", args: ["status"] },
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
      { id: "app.bun", type: "command", cmd: "bun", args: ["test"] },
    ],
    policy: policy([
      "apt install -y git",
      "corepack enable pnpm",
      "npm install -g yarn",
      "curl -fsSL https://bun.sh/install | bash",
    ]),
  });

  assert.deepEqual(
    ids(findings.filter((finding) => finding.id.includes(".tool"))),
    [],
  );
});

test("preflight lint rejects bare corepack enable as pnpm bootstrap", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
    ],
    policy: policy(["corepack enable"]),
  });

  assert.deepEqual(ids(findings), ["contract.lint.pnpm.tool"]);
});

test("preflight lint rejects bare corepack enable as yarn bootstrap", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
    ],
    policy: policy(["corepack enable"]),
  });

  assert.deepEqual(ids(findings), ["contract.structure.yarn.tool"]);
});

test("preflight lint accepts named corepack bootstraps", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
    ],
    policy: policy(["corepack enable pnpm", "corepack enable yarn"]),
  });

  assert.deepEqual(
    ids(findings.filter((finding) => finding.id.includes(".tool"))),
    [],
  );
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

test("preflight lint warns when contracts fetch or install dependencies at runtime", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "deps.npm", type: "command", cmd: "npm", args: ["ci"] },
      { id: "deps.curl", type: "command", cmd: "curl", args: ["-fsSL", "https://example.com"] },
    ],
    policy: policy([]),
  });

  assert.deepEqual(
    ids(findings.filter((finding) => finding.id.endsWith(".network"))),
    ["contract.deps.curl.network", "contract.deps.npm.network"],
  );
  assert.ok(
    findings
      .filter((finding) => finding.id.endsWith(".network"))
      .every((finding) => finding.severity === "warning"),
  );
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

test("preflight readiness classification promotes name resolution failures", () => {
  const temporaryFailure: CheckResult = {
    id: "api.resolve.temp",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "curl: (6) Temporary failure in name resolution",
    }],
  };
  const unknownHost: CheckResult = {
    id: "api.resolve.unknown",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "ssh: Name or service not known",
    }],
  };

  const classified = classifyGateReportReadiness(
    aggregate([temporaryFailure, unknownHost]),
  );

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["api.resolve.temp", "api.resolve.unknown"],
  );
});

test("preflight readiness classification promotes missing module failures", () => {
  const cannotFind: CheckResult = {
    id: "build.module.cannot-find",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "bundle step",
      how: "Error: Cannot find module 'left-pad'",
    }],
  };
  const moduleNotFound: CheckResult = {
    id: "build.module.not-found",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "bundle step",
      how: "Module not found: Can't resolve './missing.js'",
    }],
  };

  const classified = classifyGateReportReadiness(
    aggregate([cannotFind, moduleNotFound]),
  );

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["build.module.cannot-find", "build.module.not-found"],
  );
});

test("preflight readiness classification promotes service-not-started failures", () => {
  const refused: CheckResult = {
    id: "api.loopback.refused",
    type: "http",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 7，期望 0",
      why: "health check",
      how: "curl: (7) Failed to connect to 127.0.0.1 port 3000: Connection refused",
    }],
  };
  const timeout: CheckResult = {
    id: "api.loopback.timeout",
    type: "http",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 28，期望 0",
      why: "health check",
      how: "request timeout after 5000ms",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([refused, timeout]));

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["api.loopback.refused", "api.loopback.timeout"],
  );
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

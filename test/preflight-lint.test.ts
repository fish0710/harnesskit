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

test("preflight lint accepts sourced nvm wrapper followed by harmless command", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 20 && npm ci' && echo done",
    ]),
  });

  assert.deepEqual(
    findings.filter((finding: { severity: string }) => finding.severity === "error"),
    [],
  );
});

test("preflight lint rejects child-shell nvm source before later bare nvm use", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["bash -lc 'source /usr/local/nvm/nvm.sh' && nvm use 20"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects later bare nvm use after sourced child shell", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 20' && nvm use 20",
    ]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects nvm source in a pipeline before bare nvm use", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["source /usr/local/nvm/nvm.sh | cat && nvm use 20 && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects conditionally skipped nvm source before bare nvm use", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["false && source /usr/local/nvm/nvm.sh; nvm use 20 && npm ci"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects nvm use in a pipeline inside shell wrapper", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'source /usr/local/nvm/nvm.sh && nvm use 20 | cat && npm ci'",
    ]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects nvm use outside direct current-shell command position", () => {
  const parenthesized = lintGateReadiness({
    contracts: [],
    policy: policy(["source /usr/local/nvm/nvm.sh && (nvm use 20) && npm ci"]),
  });
  const envWrapped = lintGateReadiness({
    contracts: [],
    policy: policy(["source /usr/local/nvm/nvm.sh && env nvm use 20 && npm ci"]),
  });

  assert.deepEqual(ids(parenthesized), ["gateSetup.1.nvm"]);
  assert.deepEqual(ids(envWrapped), ["gateSetup.1.nvm"]);
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

test("preflight lint rejects quoted nvm source text that is not executed", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(['echo "source /usr/local/nvm/nvm.sh" && nvm use 20 && npm ci']),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
});

test("preflight lint rejects quoted bash wrapper text that is not executed", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["echo 'bash -lc \"source /usr/local/nvm/nvm.sh\"' && nvm use 20"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.nvm"]);
  assert.equal(findings[0]?.severity, "error");
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

test("preflight lint rejects redirection-delimited claude invocations", () => {
  const contracts: Contract[] = [
    { id: "agent.redirect.abs", type: "command", cmd: "/usr/local/bin/claude>/tmp/out" },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["claude>/tmp/out"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.agent.redirect.abs.claude",
    "gateSetup.1.claude",
  ]);
});

test("preflight lint rejects punctuation-delimited claude invocations", () => {
  const contracts: Contract[] = [
    { id: "agent.shell", type: "command", cmd: "if", args: ["claude;", "then", "echo", "ok", "fi"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy(["claude; echo done"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.agent.shell.claude",
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

test("preflight lint reports path-qualified default-missing package managers", () => {
  const contracts: Contract[] = [
    { id: "lint.pnpm.path", type: "command", cmd: "/usr/local/bin/pnpm", args: ["test"] },
  ];
  const findings = lintGateReadiness({
    contracts,
    policy: policy([]),
  });

  assert.deepEqual(ids(findings), ["contract.lint.pnpm.path.tool"]);
  assert.equal(findings[0]?.severity, "error");
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

test("preflight lint accepts quoted bootstrap arguments", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
      { id: "app.bun", type: "command", cmd: "bun", args: ["test"] },
    ],
    policy: policy([
      'corepack enable "pnpm"',
      'npm install -g "yarn"',
      'curl -fsSL "https://bun.sh/install" | bash',
    ]),
  });

  assert.deepEqual(
    ids(findings.filter((finding) => finding.id.includes(".tool"))),
    [],
  );
});

test("preflight lint accepts pinned package manager bootstraps", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
      { id: "app.bun", type: "command", cmd: "bun", args: ["test"] },
    ],
    policy: policy([
      "npm install -g pnpm@9",
      "npm install -g yarn@1.22.22",
      "npm install -g bun@1.1.0",
    ]),
  });

  assert.deepEqual(
    ids(findings.filter((finding) => finding.id.includes(".tool"))),
    [],
  );
});

test("preflight lint rejects quoted bootstrap text for missing package managers", () => {
  const findings = lintGateReadiness({
    contracts: [
      { id: "lint.pnpm", type: "command", cmd: "pnpm", args: ["test"] },
      { id: "structure.yarn", type: "structure", tool: "yarn", args: ["lint"] },
    ],
    policy: policy(["echo 'npm install -g pnpm'", "echo corepack enable yarn"]),
  });

  assert.deepEqual(ids(findings), [
    "contract.lint.pnpm.tool",
    "contract.structure.yarn.tool",
    "gateSetup.1.tool",
    "gateSetup.2.tool",
  ]);
});

test("preflight lint rejects gate setup tool use before later bootstrap", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["pnpm test && npm install -g pnpm", "yarn lint && corepack enable yarn"]),
  });

  assert.deepEqual(ids(findings), ["gateSetup.1.tool", "gateSetup.2.tool"]);
});

test("preflight lint accepts package manager bootstraps from earlier gate setup commands", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "corepack enable pnpm",
      "pnpm test",
      "npm install -g yarn",
      "yarn lint",
      "apt install -y git",
      "git status",
    ]),
  });

  assert.deepEqual(ids(findings), []);
});

test("preflight lint accepts shell-wrapped package manager bootstraps", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy([
      "bash -lc 'corepack enable pnpm'",
      "pnpm test",
      "bash -lc 'npm install -g yarn'",
      "yarn lint",
    ]),
  });

  assert.deepEqual(ids(findings), []);
});

test("preflight lint accepts shell-wrapped bootstrap followed by use inside wrapper", () => {
  const findings = lintGateReadiness({
    contracts: [],
    policy: policy(["bash -lc 'corepack enable pnpm && pnpm test'"]),
  });

  assert.deepEqual(ids(findings), []);
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

test("preflight readiness classification promotes bare exit-127 failures", () => {
  const result: CheckResult = {
    id: "test.spawn",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 127，期望 0",
      why: "smoke",
      how: "",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors[0]?.contractId, "test.spawn");
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
  const enotfound: CheckResult = {
    id: "api.resolve.enotfound",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "Error: getaddrinfo ENOTFOUND example.invalid",
    }],
  };

  const classified = classifyGateReportReadiness(
    aggregate([temporaryFailure, unknownHost, enotfound]),
  );

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["api.resolve.enotfound", "api.resolve.temp", "api.resolve.unknown"],
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

test("preflight readiness classification promotes node module resolution failures", () => {
  const errModule: CheckResult = {
    id: "build.module.err-module-not-found",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "bundle step",
      how: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /workspace/candidate/src/app.mjs",
    }],
  };
  const cannotFindPackage: CheckResult = {
    id: "build.module.cannot-find-package",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "bundle step",
      how: "Cannot find package 'left-pad' imported from /workspace/candidate/src/app.mjs",
    }],
  };

  const classified = classifyGateReportReadiness(
    aggregate([errModule, cannotFindPackage]),
  );

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["build.module.cannot-find-package", "build.module.err-module-not-found"],
  );
});

test("preflight readiness classification promotes module paths containing expected", () => {
  const result: CheckResult = {
    id: "build.module.expected-path",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "bundle step",
      how: "Error: Cannot find module './expected'",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors[0]?.contractId, "build.module.expected-path");
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

test("preflight readiness classification promotes econnrefused failures", () => {
  const result: CheckResult = {
    id: "api.loopback.econnrefused",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "health check",
      how: "Error: connect ECONNREFUSED 127.0.0.1:3000",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors[0]?.contractId, "api.loopback.econnrefused");
});

test("preflight readiness classification keeps request timed out assertions as product failures", () => {
  const result: CheckResult = {
    id: "spec.request-timeout.behavior",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "behavior spec",
      how: "expected request timed out error but received success",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures, ["spec.request-timeout.behavior"]);
});

test("preflight readiness classification keeps fetch timeout assertions as product failures", () => {
  const result: CheckResult = {
    id: "spec.fetch-timeout.behavior",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "behavior spec",
      how: "expected fetch timeout error but received success",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures, ["spec.fetch-timeout.behavior"]);
});

test("preflight readiness classification keeps infra-word timeout assertions as product failures", () => {
  const results: CheckResult[] = [
    {
      id: "spec.axios-timeout.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected axios timeout error but received success",
      }],
    },
    {
      id: "spec.health-timeout.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected health endpoint timeout but got ok",
      }],
    },
    {
      id: "spec.connection-timeout.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected connection timeout error but received success",
      }],
    },
  ];

  const classified = classifyGateReportReadiness(aggregate(results));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures.sort(), [
    "spec.axios-timeout.behavior",
    "spec.connection-timeout.behavior",
    "spec.health-timeout.behavior",
  ]);
});

test("preflight readiness classification keeps readiness-keyword assertions as product failures", () => {
  const results: CheckResult[] = [
    {
      id: "spec.econnrefused.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected ECONNREFUSED error but received success",
      }],
    },
    {
      id: "spec.module.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected Cannot find module error but received success",
      }],
    },
    {
      id: "spec.connection-timed-out.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected connection timed out error but received success",
      }],
    },
  ];

  const classified = classifyGateReportReadiness(aggregate(results));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures.sort(), [
    "spec.connection-timed-out.behavior",
    "spec.econnrefused.behavior",
    "spec.module.behavior",
  ]);
});

test("preflight readiness classification keeps prefixed expected-error assertions as product failures", () => {
  const results: CheckResult[] = [
    {
      id: "spec.assertion-prefixed-econnrefused.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "AssertionError [ERR_ASSERTION]: expected ECONNREFUSED error but received success",
      }],
    },
    {
      id: "spec.error-prefixed-module.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "Error: expected Cannot find module error but received success",
      }],
    },
  ];

  const classified = classifyGateReportReadiness(aggregate(results));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures.sort(), [
    "spec.assertion-prefixed-econnrefused.behavior",
    "spec.error-prefixed-module.behavior",
  ]);
});

test("preflight readiness classification keeps short expected-error assertions as product failures", () => {
  const results: CheckResult[] = [
    {
      id: "spec.expected-econnrefused.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected ECONNREFUSED error",
      }],
    },
    {
      id: "spec.assertion-module.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "AssertionError: expected Cannot find module to equal actual error",
      }],
    },
    {
      id: "spec.expected-timeout.behavior",
      type: "command",
      status: "fail",
      durationMs: 12,
      violations: [{
        what: "命令退出码 1，期望 0",
        why: "behavior spec",
        how: "expected connection timed out error",
      }],
    },
  ];

  const classified = classifyGateReportReadiness(aggregate(results));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures.sort(), [
    "spec.assertion-module.behavior",
    "spec.expected-econnrefused.behavior",
    "spec.expected-timeout.behavior",
  ]);
});

test("preflight readiness classification promotes actual readiness after assertion wording", () => {
  const multiline: CheckResult = {
    id: "api.resolve.after-assertion",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "expected health check to pass but got error\nError: getaddrinfo ENOTFOUND example.invalid",
    }],
  };
  const actualInGot: CheckResult = {
    id: "api.refused.actual-got",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "expected status 200 but got ECONNREFUSED",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([multiline, actualInGot]));

  assert.deepEqual(classified.productFailures, []);
  assert.deepEqual(
    classified.readinessErrors.map((finding) => finding.contractId).sort(),
    ["api.refused.actual-got", "api.resolve.after-assertion"],
  );
});

test("preflight readiness classification promotes actual runtime evidence after assertions", () => {
  const result: CheckResult = {
    id: "api.refused.actual-error",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "http smoke",
      how: "expected success but actual Error: connect ECONNREFUSED 127.0.0.1:3000",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors[0]?.contractId, "api.refused.actual-error");
});

test("preflight readiness classification promotes missing nvm version failures", () => {
  const result: CheckResult = {
    id: "setup.nvm.missing-version",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 3，期望 0",
      why: "runtime setup",
      how: 'N/A: version "14.21.3" is not yet installed.',
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.productFailures, []);
  assert.equal(classified.readinessErrors[0]?.contractId, "setup.nvm.missing-version");
});

test("preflight readiness classification keeps ordinary timeout assertions as product failures", () => {
  const result: CheckResult = {
    id: "spec.timeout.behavior",
    type: "command",
    status: "fail",
    durationMs: 12,
    violations: [{
      what: "命令退出码 1，期望 0",
      why: "behavior spec",
      how: "expected timeout error but received success; request should timeout after 5s",
    }],
  };

  const classified = classifyGateReportReadiness(aggregate([result]));

  assert.deepEqual(classified.readinessErrors, []);
  assert.deepEqual(classified.productFailures, ["spec.timeout.behavior"]);
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

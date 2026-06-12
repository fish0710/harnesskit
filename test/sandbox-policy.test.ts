import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadSandboxPolicy,
  normalizeWorkspacePath,
  validateCandidatePath,
} from "../src/harness/sandbox/policy.js";

test("candidate path must be relative and inside an allowed root", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: [
        "src",
        "test/generated",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
      ],
      protectedPaths: ["src/gates", "contracts"],
    },
  });

  assert.equal(validateCandidatePath("src/app.ts", policy), "src/app.ts");
  assert.throws(() => validateCandidatePath("../secret", policy), /越界/);
  assert.throws(() => validateCandidatePath("/etc/passwd", policy), /绝对路径/);
  assert.throws(() => validateCandidatePath("README.md", policy), /允许范围/);
  assert.throws(
    () => validateCandidatePath("src/gates/judge.ts", policy),
    /受保护/,
  );
});

test("normalization rejects ambiguous path spellings", () => {
  assert.equal(normalizeWorkspacePath("src/a.ts"), "src/a.ts");
  assert.throws(() => normalizeWorkspacePath("src//a.ts"), /非法路径/);
  assert.throws(() => normalizeWorkspacePath("src/./a.ts"), /非法路径/);
  assert.throws(() => normalizeWorkspacePath("src\\a.ts"), /非法路径/);
});

test("normalization rejects empty, parent, trailing, and NUL paths", () => {
  for (const path of ["", ".", "..", "src/../secret", "src/", "src/\0file"]) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径|越界/);
  }
});

test("normalization rejects Windows drive and UNC paths", () => {
  for (const path of [
    "C:\\repo\\file.ts",
    "C:/repo/file.ts",
    "C:repo/file.ts",
    "\\\\server\\share\\file.ts",
    "//server/share/file.ts",
  ]) {
    assert.throws(
      () => normalizeWorkspacePath(path),
      /绝对路径|非法路径/,
    );
  }
});

test("candidate root prefix checks are path-boundary aware", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: [],
    },
  });

  assert.equal(validateCandidatePath("src/file.ts", policy), "src/file.ts");
  assert.throws(
    () => validateCandidatePath("src2/file.ts", policy),
    /允许范围/,
  );
});

test("protected prefix checks are path-boundary aware", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["src/gates"],
    },
  });

  assert.equal(
    validateCandidatePath("src/gates2/judge.ts", policy),
    "src/gates2/judge.ts",
  );
  assert.throws(
    () => validateCandidatePath("src/gates/judge.ts", policy),
    /受保护/,
  );
});

test("loadSandboxPolicy returns conservative defaults", () => {
  assert.deepEqual(loadSandboxPolicy({}), {
    candidateRoots: [
      "src",
      "lib",
      "test/generated",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
    protectedPaths: [
      "contracts",
      ".harness",
      "harness.config.json",
      ".github/workflows",
      "CODEOWNERS",
    ],
    agentSetup: [],
    gateSetup: [],
    limits: {
      maxFiles: 10_000,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 200 * 1024 * 1024,
    },
    retainOnFailure: false,
  });
});

test("loadSandboxPolicy merges known sandbox fields and nested limits", () => {
  const policy = loadSandboxPolicy({
    baseline: ["smoke.boot"],
    rules: [],
    sandbox: {
      candidateRoots: ["app"],
      agentSetup: ["npm ci"],
      limits: { maxFiles: 25 },
      retainOnFailure: true,
    },
  });

  assert.deepEqual(policy.candidateRoots, ["app"]);
  assert.deepEqual(policy.agentSetup, ["npm ci"]);
  assert.deepEqual(policy.gateSetup, []);
  assert.deepEqual(policy.limits, {
    maxFiles: 25,
    maxFileBytes: 10 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
  });
  assert.equal(policy.retainOnFailure, true);
});

test("loadSandboxPolicy normalizes every configured path strictly", () => {
  for (const path of ["src//generated", "src/../generated", "C:/repo"]) {
    assert.throws(
      () =>
        loadSandboxPolicy({
          sandbox: {
            candidateRoots: [path],
            protectedPaths: [],
          },
        }),
      /绝对路径|非法路径|越界/,
    );
  }

  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: {
          candidateRoots: ["src"],
          protectedPaths: ["contracts/"],
        },
      }),
    /非法路径/,
  );
});

test("loadSandboxPolicy rejects unknown sandbox and limit fields", () => {
  assert.throws(
    () => loadSandboxPolicy({ sandbox: { candidateRoot: ["src"] } }),
    /未知.*candidateRoot/,
  );
  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: {
          limits: { maxFileByte: 100 },
        },
      }),
    /未知.*maxFileByte/,
  );
});

test("loadSandboxPolicy rejects wrong field types", () => {
  const invalidConfigs: unknown[] = [
    null,
    [],
    "config",
    { sandbox: undefined },
    { sandbox: null },
    { sandbox: [] },
    { sandbox: { candidateRoots: undefined } },
    { sandbox: { candidateRoots: "src" } },
    { sandbox: { candidateRoots: [1] } },
    { sandbox: { protectedPaths: "contracts" } },
    { sandbox: { protectedPaths: [false] } },
    { sandbox: { agentSetup: "npm ci" } },
    { sandbox: { agentSetup: [1] } },
    { sandbox: { gateSetup: {} } },
    { sandbox: { gateSetup: [null] } },
    { sandbox: { limits: [] } },
    { sandbox: { limits: { maxFiles: undefined } } },
    { sandbox: { retainOnFailure: undefined } },
    { sandbox: { retainOnFailure: "false" } },
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => loadSandboxPolicy(config),
      /配置|类型|字符串|布尔|正安全整数/,
    );
  }
});

test("loadSandboxPolicy requires non-empty candidate roots", () => {
  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: { candidateRoots: [] },
      }),
    /candidateRoots.*非空/,
  );
});

test("loadSandboxPolicy requires positive safe-integer limits", () => {
  const invalid = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "10",
  ];

  for (const field of ["maxFiles", "maxFileBytes", "maxTotalBytes"] as const) {
    for (const value of invalid) {
      assert.throws(
        () =>
          loadSandboxPolicy({
            sandbox: {
              limits: { [field]: value },
            },
          }),
        new RegExp(`${field}.*正安全整数`),
      );
    }
  }
});

test("loadSandboxPolicy rejects candidate roots fully covered by protection", () => {
  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: {
          candidateRoots: ["src", "lib/generated"],
          protectedPaths: ["src", "lib"],
        },
      }),
    /所有 candidateRoots.*受保护/,
  );
});

test("loadSandboxPolicy allows protected subtrees and partial root coverage", () => {
  assert.doesNotThrow(() =>
    loadSandboxPolicy({
      sandbox: {
        candidateRoots: ["src"],
        protectedPaths: ["src/gates"],
      },
    }),
  );
  assert.doesNotThrow(() =>
    loadSandboxPolicy({
      sandbox: {
        candidateRoots: ["src", "lib"],
        protectedPaths: ["src", "lib/gates"],
      },
    }),
  );
});

test("loadSandboxPolicy returns fresh defaults that cannot be mutated globally", () => {
  const first = loadSandboxPolicy({});
  first.candidateRoots.push("unsafe");
  first.protectedPaths.length = 0;
  first.agentSetup.push("mutated");
  first.gateSetup.push("mutated");
  first.limits.maxFiles = 1;

  const second = loadSandboxPolicy({});
  assert.equal(second.candidateRoots.includes("unsafe"), false);
  assert.deepEqual(second.protectedPaths, [
    "contracts",
    ".harness",
    "harness.config.json",
    ".github/workflows",
    "CODEOWNERS",
  ]);
  assert.deepEqual(second.agentSetup, []);
  assert.deepEqual(second.gateSetup, []);
  assert.equal(second.limits.maxFiles, 10_000);
});

test("loadSandboxPolicy copies caller-owned arrays and objects", () => {
  const sandbox = {
    candidateRoots: ["src"],
    protectedPaths: ["src/gates"],
    agentSetup: ["npm ci"],
    gateSetup: ["npm test"],
    limits: {
      maxFiles: 5,
      maxFileBytes: 10,
      maxTotalBytes: 20,
    },
  };
  const policy = loadSandboxPolicy({ sandbox });

  sandbox.candidateRoots.push("lib");
  sandbox.protectedPaths.length = 0;
  sandbox.agentSetup[0] = "changed";
  sandbox.gateSetup[0] = "changed";
  sandbox.limits.maxFiles = 99;

  assert.deepEqual(policy.candidateRoots, ["src"]);
  assert.deepEqual(policy.protectedPaths, ["src/gates"]);
  assert.deepEqual(policy.agentSetup, ["npm ci"]);
  assert.deepEqual(policy.gateSetup, ["npm test"]);
  assert.equal(policy.limits.maxFiles, 5);
});

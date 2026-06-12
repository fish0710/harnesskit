import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadSandboxPolicy,
  normalizeWorkspacePath,
  protectedFilesystemPathKey,
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

test("normalization rejects Windows alternate data streams", () => {
  assert.throws(
    () => normalizeWorkspacePath("src/secret.txt::$DATA"),
    /非法路径/,
  );
});

test("normalization rejects Windows-invalid characters in any segment", () => {
  for (const character of ["<", ">", ":", "\"", "|", "?", "*"]) {
    assert.throws(
      () => normalizeWorkspacePath(`src/a${character}b/file.ts`),
      /非法路径/,
    );
  }
});

test("normalization rejects every ASCII control character", () => {
  for (let code = 0; code <= 0x1f; code++) {
    assert.throws(
      () => normalizeWorkspacePath(`src/a${String.fromCharCode(code)}b.ts`),
      /非法路径/,
    );
  }
});

test("normalization rejects unpaired UTF-16 surrogates", () => {
  for (const path of [
    "src/lone-high-\ud800",
    "src/lone-\ud800.ts",
    "src/lone-\udc00.ts",
    "src/broken-\ud800x.ts",
  ]) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径/);
  }
});

test("normalization accepts valid supplementary Unicode code points", () => {
  const path = "src/emoji-😀.ts";
  assert.equal(normalizeWorkspacePath(path), path);
});

test("normalization rejects segments ending in dot or ASCII space", () => {
  for (const path of [
    "src/file.",
    "src/dir./file.ts",
    "src/file ",
    "src/dir /file.ts",
  ]) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径/);
  }
});

test("normalization rejects Windows reserved device basenames with extensions", () => {
  const reservedPaths = [
    "con",
    "CON.txt",
    "src/prn",
    "src/AUX.json",
    "src/nul.log",
  ];
  for (let number = 1; number <= 9; number++) {
    reservedPaths.push(`src/com${number}`, `src/LPT${number}.log`);
  }

  for (const path of reservedPaths) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径/);
  }
});

test("normalization rejects possible NTFS 8.3 short-name aliases", () => {
  for (const path of [
    "src/SECRET~1.JSO",
    "src/foo~1.txt",
    "src/archive~123/data.json",
  ]) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径/);
  }
});

test("normalization rejects superscript Windows device basenames", () => {
  for (const path of [
    "COM¹",
    "com².txt",
    "src/COM³.log",
    "src/LPT¹",
    "src/lpt².txt",
    "src/LpT³.json",
  ]) {
    assert.throws(() => normalizeWorkspacePath(path), /非法路径/);
  }
});

test("normalization accepts portable near-miss names", () => {
  for (const path of [
    "console.ts",
    "src/printer",
    "src/auxiliary.json",
    "src/null.log",
    "src/com10",
    "src/lpt10.log",
    "src/com1extra.txt",
    "src/plain~name.txt",
    "src/trailing~",
    "src/foo~bar1.txt",
  ]) {
    assert.equal(normalizeWorkspacePath(path), path);
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

test("darwin blocks protected filesystem aliases", () => {
  for (const [protectedPath, candidatePath] of [
    ["src/Gates", "src/gates/file.ts"],
    ["src/gates", "src/Gates/file.ts"],
    ["src/café", "src/cafe\u0301/file.ts"],
    ["src/σ", "src/ς/file.ts"],
    ["src/straße", "src/STRASSE/file.ts"],
    ["src/ſafe", "src/safe/file.ts"],
  ] as const) {
    const policy = loadSandboxPolicy({
      sandbox: {
        candidateRoots: ["src"],
        protectedPaths: [protectedPath],
      },
    }, "darwin");

    assert.throws(
      () => validateCandidatePath(candidatePath, policy, "darwin"),
      /受保护/,
    );
  }
});

test("candidate allowlists stay exact and volume-independent on every platform", () => {
  // Allowlisting is intentionally narrower than host filesystem aliasing.
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const policy = loadSandboxPolicy({
      sandbox: {
        candidateRoots: ["src"],
        protectedPaths: [],
      },
    }, platform);

    assert.throws(
      () => validateCandidatePath("SRC/x", policy, platform),
      /允许范围/,
    );
  }

  const unicodePolicy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src/café"],
      protectedPaths: [],
    },
  }, "darwin");
  assert.throws(
    () => validateCandidatePath("src/cafe\u0301/x", unicodePolicy, "darwin"),
    /允许范围/,
  );
});

test("linux path comparisons remain case and Unicode sensitive", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src", "SRC"],
      protectedPaths: ["src/Gates", "src/café"],
    },
  }, "linux");

  assert.equal(validateCandidatePath("src/gates/x", policy, "linux"), "src/gates/x");
  assert.equal(validateCandidatePath("SRC/x", policy, "linux"), "SRC/x");
  assert.throws(
    () =>
      validateCandidatePath(
        "src/cafe\u0301/x",
        loadSandboxPolicy({
          sandbox: {
            candidateRoots: ["src/café"],
            protectedPaths: [],
          },
        }, "linux"),
        "linux",
      ),
    /允许范围/,
  );
});

test("linux candidate root casing does not match a distinct candidate path", () => {
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: [],
    },
  }, "linux");

  assert.throws(
    () => validateCandidatePath("SRC/x", policy, "linux"),
    /允许范围/,
  );
});

test("protected filesystem path keys keep accent-distinct APFS names separate", () => {
  assert.notEqual(
    protectedFilesystemPathKey("src/cafe", "darwin"),
    protectedFilesystemPathKey("src/café", "darwin"),
  );

  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src/cafe"],
      protectedPaths: [],
    },
  }, "darwin");
  assert.throws(
    () => validateCandidatePath("src/café/x", policy, "darwin"),
    /允许范围/,
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

test("loadSandboxPolicy requires plain or null-prototype records", () => {
  class ConfigInstance {
    sandbox = {};
  }

  class SandboxInstance {
    candidateRoots = ["src"];
  }

  class LimitsInstance {
    maxFiles = 10;
  }

  const inheritedSandbox = Object.create({ protectedPaths: [] }) as Record<
    string,
    unknown
  >;
  inheritedSandbox.candidateRoots = ["src"];

  const invalidConfigs: unknown[] = [
    new Date(),
    new ConfigInstance(),
    { sandbox: new Date() },
    { sandbox: new SandboxInstance() },
    { sandbox: inheritedSandbox },
    { sandbox: { limits: new Date() } },
    { sandbox: { limits: new LimitsInstance() } },
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => loadSandboxPolicy(config),
      /配置必须是普通对象/,
    );
  }

  const nullPrototypeConfig = Object.create(null) as Record<string, unknown>;
  const nullPrototypeSandbox = Object.create(null) as Record<string, unknown>;
  const nullPrototypeLimits = Object.create(null) as Record<string, unknown>;
  nullPrototypeLimits.maxFiles = 5;
  nullPrototypeSandbox.candidateRoots = ["src"];
  nullPrototypeSandbox.protectedPaths = [];
  nullPrototypeSandbox.limits = nullPrototypeLimits;
  nullPrototypeConfig.sandbox = nullPrototypeSandbox;

  assert.equal(loadSandboxPolicy(nullPrototypeConfig).limits.maxFiles, 5);
});

test("loadSandboxPolicy rejects an own JSON __proto__ sandbox field", () => {
  const config = JSON.parse(
    '{"sandbox":{"candidateRoots":["src"],"__proto__":{"protectedPaths":[]}}}',
  ) as unknown;

  assert.throws(
    () => loadSandboxPolicy(config),
    /未知 sandbox 字段: __proto__/,
  );
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

test("overlap checks use case and Unicode comparison keys", () => {
  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: {
          candidateRoots: ["SRC/Gates"],
          protectedPaths: ["src/gates"],
        },
      }, "darwin"),
    /所有 candidateRoots.*受保护/,
  );

  assert.throws(
    () =>
      loadSandboxPolicy({
        sandbox: {
          candidateRoots: ["src/cafe\u0301"],
          protectedPaths: ["SRC/CAFÉ"],
        },
      }, "darwin"),
    /所有 candidateRoots.*受保护/,
  );
});

test("linux overlap checks keep distinct path spellings separate", () => {
  assert.doesNotThrow(() =>
    loadSandboxPolicy({
      sandbox: {
        candidateRoots: ["src/gates"],
        protectedPaths: ["src/Gates"],
      },
    }, "linux"),
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

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import {
  agentVisibleFiles,
  captureWorkspace,
  collectCandidate,
  deriveCandidateOperations,
  workspaceFile,
  type RemoteFileEntry,
  type RemoteWorkspace,
} from "../src/harness/sandbox/workspace.js";
import {
  publishCandidate,
  type PublishHooks,
} from "../src/harness/sandbox/publish.js";
import type {
  CandidateSnapshot,
  SandboxPolicy,
  WorkspaceSnapshot,
} from "../src/harness/sandbox/types.js";

const temporaryRoots = new Set<string>();

after(() => {
  for (const root of temporaryRoots) {
    chmodTreeForCleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function policy(
  limits: Partial<SandboxPolicy["limits"]> = {},
): SandboxPolicy {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts", "src/protected"],
      limits,
    },
  });
}

function createGitFixture(
  files: Record<string, string | Buffer>,
): string {
  const root = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  temporaryRoots.add(root);
  git(root, ["init"]);
  for (const [path, content] of Object.entries(files)) {
    writeFixtureFile(root, path, content);
  }
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Harness Test",
    "-c",
    "user.email=harness@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return root;
}

function createTemporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  temporaryRoots.add(root);
  return root;
}

function writeFixtureFile(
  root: string,
  path: string,
  content: string | Buffer,
): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function fakeRemoteFiles(
  files: Record<string, string | Buffer | {
    content: string | Buffer;
    executable: boolean;
  }>,
): RemoteWorkspace {
  const entries = new Map(
    Object.entries(files).map(([path, value]) => {
      const executable =
        typeof value === "object" &&
        !Buffer.isBuffer(value) &&
        "executable" in value
          ? value.executable
          : false;
      const source =
        typeof value === "object" &&
        !Buffer.isBuffer(value) &&
        "content" in value
          ? value.content
          : value;
      const content = Buffer.isBuffer(source)
        ? source
        : Buffer.from(source);
      return [
        path,
        {
          entry: {
            path,
            kind: "file" as const,
            size: content.byteLength,
            executable,
          },
          content,
        },
      ];
    }),
  );

  return {
    async list() {
      return [...entries.values()].map(({ entry }) => ({ ...entry }));
    },
    async read(path) {
      const found = entries.get(path);
      if (!found) throw new Error(`missing fake file: ${path}`);
      return found.content;
    },
  };
}

function fakeRemoteEntries(
  entries: RemoteFileEntry[],
  reads: Record<string, Buffer> = {},
): RemoteWorkspace {
  return {
    async list() {
      return entries;
    },
    async read(path) {
      return reads[path] ?? Buffer.from("x");
    },
  };
}

function candidateReplacing(
  baseline: WorkspaceSnapshot,
  path: string,
  content: string,
  executable?: boolean,
): CandidateSnapshot {
  const before = baseline.files.get(path);
  if (!before) throw new Error(`missing baseline file: ${path}`);
  const file = workspaceFile(
    path,
    Buffer.from(content),
    executable ?? before.executable,
  );
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((item) => [item.path, item]),
  );
  files.set(path, file);
  return {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };
}

function operationPaths(candidate: CandidateSnapshot): string[][] {
  return candidate.operations.map((operation) => [
    operation.kind,
    operation.kind === "delete"
      ? operation.before.path
      : operation.file.path,
  ]);
}

function chmodTreeForCleanup(root: string): void {
  try {
    chmodSync(root, 0o755);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        chmodTreeForCleanup(join(root, entry.name));
      }
    }
  } catch {
    // Best-effort cleanup for fixtures intentionally made unwritable.
  }
}

test("capture includes dirty and untracked bytes but excludes ignored outputs", () => {
  const root = createGitFixture({
    ".gitignore": "node_modules/\ndist/\n",
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "id: gate\n",
  });
  writeFixtureFile(root, "src/a.ts", "dirty\n");
  writeFixtureFile(root, "src/untracked.ts", "untracked\n");
  writeFixtureFile(root, "node_modules/pkg/tracked.js", "tracked ignored\n");
  git(root, ["add", "-f", "node_modules/pkg/tracked.js"]);
  git(root, [
    "-c",
    "user.name=Harness Test",
    "-c",
    "user.email=harness@example.invalid",
    "commit",
    "-m",
    "track ignored output",
  ]);
  writeFixtureFile(root, "node_modules/pkg/untracked.js", "ignored\n");
  writeFixtureFile(root, "dist/index.js", "ignored\n");

  const snapshot = captureWorkspace(root, policy());

  assert.equal(snapshot.root, root);
  assert.equal(snapshot.files.get("src/a.ts")?.content.toString(), "dirty\n");
  assert.equal(
    snapshot.files.get("src/untracked.ts")?.content.toString(),
    "untracked\n",
  );
  assert.equal(
    snapshot.files.get("contracts/gate.yaml")?.content.toString(),
    "id: gate\n",
  );
  assert.equal(
    snapshot.files.get("node_modules/pkg/tracked.js")?.content.toString(),
    "tracked ignored\n",
  );
  assert.equal(snapshot.files.has("node_modules/pkg/untracked.js"), false);
  assert.equal(snapshot.files.has("dist/index.js"), false);
  assert.equal(
    [...snapshot.files.keys()].some((path) => path.startsWith(".git/")),
    false,
  );
});

test("capture rejects a non-Git directory", () => {
  assert.throws(
    () => captureWorkspace(createTemporaryDirectory(), policy()),
    /Git|工作树/,
  );
});

test("capture requires the repository worktree root, not a nested directory", () => {
  const root = createGitFixture({ "src/a.ts": "a" });

  assert.throws(
    () => captureWorkspace(join(root, "src"), policy()),
    /根目录|顶层/,
  );
});

test("capture rejects a tracked symbolic link", () => {
  const root = createGitFixture({ "src/target.ts": "target\n" });
  symlinkSync("target.ts", join(root, "src/link.ts"));
  git(root, ["add", "src/link.ts"]);

  assert.throws(
    () => captureWorkspace(root, policy()),
    /符号链接|文件类型/,
  );
});

test("capture rejects tracked files beneath a symlinked parent", () => {
  const root = createGitFixture({ "src/nested/a.ts": "inside\n" });
  const outside = createTemporaryDirectory();
  writeFixtureFile(outside, "a.ts", "outside\n");
  rmSync(join(root, "src/nested"), { recursive: true });
  symlinkSync(outside, join(root, "src/nested"));

  assert.throws(
    () => captureWorkspace(root, policy()),
    /父路径|符号链接|工作区外/,
  );
});

test("capture rejects Git paths that are not valid UTF-8", () => {
  const root = createGitFixture({ "src/a.ts": "a" });
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: "invalid name\n",
    encoding: "utf8",
  });
  assert.equal(blob.status, 0, blob.stderr);
  const indexEntry = Buffer.concat([
    Buffer.from(`100644 ${blob.stdout.trim()}\tsrc/bad-`),
    Buffer.from([0xff, 0]),
  ]);
  const update = spawnSync("git", ["update-index", "-z", "--index-info"], {
    cwd: root,
    input: indexEntry,
    encoding: "buffer",
  });
  assert.equal(update.status, 0, update.stderr.toString());

  assert.throws(
    () => captureWorkspace(root, policy()),
    /UTF-8|路径编码/,
  );
});

test("capture enforces file count, per-file, and total byte limits", () => {
  const root = createGitFixture({
    "src/a.ts": "aa",
    "src/b.ts": "bb",
  });

  assert.throws(
    () => captureWorkspace(root, policy({ maxFiles: 1 })),
    /文件数量|限制/,
  );
  assert.throws(
    () => captureWorkspace(root, policy({ maxFileBytes: 1 })),
    /文件.*大小|限制/,
  );
  assert.throws(
    () => captureWorkspace(root, policy({ maxTotalBytes: 3 })),
    /总大小|限制/,
  );
});

test("workspaceFile owns bytes and computes the full SHA-256", () => {
  const source = Buffer.from("candidate");
  const file = workspaceFile("src/a.ts", source, false);
  source.fill(0);

  assert.equal(file.content.toString(), "candidate");
  assert.equal(
    file.sha256,
    "dda18a0e21ae47c53b4309434cbc02ae8bf764fa83a6defbb719431242722aa7",
  );
});

test("agentVisibleFiles returns sorted mutable files only", () => {
  const root = createGitFixture({
    "README.md": "outside\n",
    "src/z.ts": "z\n",
    "src/a.ts": "a\n",
    "src/protected/gate.ts": "protected\n",
    "contracts/gate.yaml": "id: gate\n",
  });

  assert.deepEqual(
    agentVisibleFiles(captureWorkspace(root, policy()), policy())
      .map((file) => file.path),
    ["src/a.ts", "src/z.ts"],
  );
});

test("collector computes deterministic add, modify, and delete operations", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "src/delete.ts": "remove\n",
    "contracts/gate.yaml": "id: gate\n",
  });
  const baseline = captureWorkspace(root, policy());

  const candidate = await collectCandidate(
    fakeRemoteFiles({
      "src/new.ts": "new\n",
      "src/a.ts": "after\n",
    }),
    baseline,
    policy(),
  );

  assert.deepEqual(operationPaths(candidate), [
    ["modify", "src/a.ts"],
    ["delete", "src/delete.ts"],
    ["add", "src/new.ts"],
  ]);
  assert.deepEqual([...candidate.files.keys()].sort(), [
    "src/a.ts",
    "src/new.ts",
  ]);
  assert.equal(
    candidate.files.get("src/a.ts")?.content.toString(),
    "after\n",
  );
});

test("collector ignores directory traversal metadata but rejects links and special files", async () => {
  const baseline = captureWorkspace(
    createGitFixture({ "src/a.ts": "a" }),
    policy(),
  );
  const withDirectory = await collectCandidate(
    fakeRemoteEntries(
      [
        {
          path: "src",
          kind: "directory",
          size: 0,
          executable: false,
        },
        {
          path: "src/a.ts",
          kind: "file",
          size: 1,
          executable: false,
        },
      ],
      { "src/a.ts": Buffer.from("a") },
    ),
    baseline,
    policy(),
  );
  assert.deepEqual(withDirectory.operations, []);

  for (const kind of ["symlink", "special"] as const) {
    await assert.rejects(
      () =>
        collectCandidate(
          fakeRemoteEntries([
            {
              path: "src/link",
              kind,
              size: 1,
              executable: false,
            },
          ]),
          baseline,
          policy(),
        ),
      /符号链接|文件类型/,
    );
  }
});

test("collector rejects malformed metadata, limit violations, and short reads", async () => {
  const baseline = captureWorkspace(
    createGitFixture({ "src/a.ts": "a" }),
    policy(),
  );
  const invalidEntries: RemoteFileEntry[] = [
    {
      path: "src/a.ts",
      kind: "file",
      size: -1,
      executable: false,
    },
    {
      path: "src/a.ts",
      kind: "file",
      size: 1.5,
      executable: false,
    },
    {
      path: "src/a.ts",
      kind: "file",
      size: Number.MAX_SAFE_INTEGER + 1,
      executable: false,
    },
    {
      path: "src/a.ts",
      kind: "file",
      size: 1,
      executable: undefined as unknown as boolean,
    },
  ];
  for (const entry of invalidEntries) {
    await assert.rejects(
      () => collectCandidate(fakeRemoteEntries([entry]), baseline, policy()),
      /大小|安全整数|executable|可执行/,
    );
  }

  await assert.rejects(
    () =>
      collectCandidate(
        fakeRemoteEntries([
          {
            path: "src/a.ts",
            kind: "file",
            size: 2,
            executable: false,
          },
        ], { "src/a.ts": Buffer.from("a") }),
        baseline,
        policy(),
      ),
    /读取大小不一致/,
  );
  await assert.rejects(
    () =>
      collectCandidate(
        fakeRemoteFiles({
          "src/a.ts": "aa",
          "src/b.ts": "bb",
        }),
        baseline,
        policy({ maxFiles: 1 }),
      ),
    /文件数量|限制/,
  );
  await assert.rejects(
    () =>
      collectCandidate(
        fakeRemoteFiles({ "src/a.ts": "aa" }),
        baseline,
        policy({ maxFileBytes: 1 }),
      ),
    /文件.*大小|限制/,
  );
  await assert.rejects(
    () =>
      collectCandidate(
        fakeRemoteFiles({
          "src/a.ts": "aa",
          "src/b.ts": "bb",
        }),
        baseline,
        policy({ maxTotalBytes: 3 }),
      ),
    /总大小|限制/,
  );
});

test("collector rejects duplicate and host-aliased normalized paths", async () => {
  const baseline = captureWorkspace(
    createGitFixture({ "src/base.ts": "a" }),
    policy(),
  );
  const duplicate: RemoteFileEntry = {
    path: "src/a.ts",
    kind: "file",
    size: 1,
    executable: false,
  };
  await assert.rejects(
    () =>
      collectCandidate(
        fakeRemoteEntries(
          [duplicate, { ...duplicate }],
          { "src/a.ts": Buffer.from("a") },
        ),
        baseline,
        policy(),
      ),
    /重复|别名/,
  );

  if (process.platform === "darwin" || process.platform === "win32") {
    await assert.rejects(
      () =>
        collectCandidate(
          fakeRemoteFiles({
            "src/a.ts": "a",
            "src/A.ts": "b",
          }),
          baseline,
          policy(),
        ),
      /重复|别名/,
    );
  }
});

test("collector rejects protected and outside candidate paths", async () => {
  const baseline = captureWorkspace(
    createGitFixture({ "src/a.ts": "a" }),
    policy(),
  );

  for (const path of [
    "src/protected/gate.ts",
    "contracts/gate.yaml",
    "README.md",
    "../escape.ts",
  ]) {
    await assert.rejects(
      () => collectCandidate(fakeRemoteFiles({ [path]: "x" }), baseline, policy()),
      /受保护|允许范围|越界/,
    );
  }
});

test("collector records executable-mode-only modifications", async () => {
  const root = createGitFixture({ "src/tool.sh": "#!/bin/sh\n" });
  const baseline = captureWorkspace(root, policy());

  const candidate = await collectCandidate(
    fakeRemoteFiles({
      "src/tool.sh": {
        content: "#!/bin/sh\n",
        executable: true,
      },
    }),
    baseline,
    policy(),
  );

  assert.deepEqual(operationPaths(candidate), [["modify", "src/tool.sh"]]);
  assert.equal(candidate.files.get("src/tool.sh")?.executable, true);
});

test("collector owns downloaded buffers used as evaluated candidate bytes", async () => {
  const root = createGitFixture({ "src/a.ts": "before" });
  const baseline = captureWorkspace(root, policy());
  const downloaded = Buffer.from("accepted");

  const candidate = await collectCandidate(
    fakeRemoteFiles({ "src/a.ts": downloaded }),
    baseline,
    policy(),
  );
  downloaded.fill(0);

  assert.equal(
    candidate.files.get("src/a.ts")?.content.toString(),
    "accepted",
  );
});

test("publisher applies exact evaluated bytes, deletions, and executable mode", async () => {
  const root = createGitFixture({
    "src/a.ts": "before",
    "src/delete.ts": "delete",
    "src/tool.sh": "#!/bin/sh\n",
  });
  const baseline = captureWorkspace(root, policy());
  const remoteBytes = Buffer.from([0, 1, 2, 255]);
  const candidate = await collectCandidate(
    fakeRemoteFiles({
      "src/a.ts": remoteBytes,
      "src/new.ts": "new\n",
      "src/tool.sh": {
        content: "#!/bin/sh\n",
        executable: true,
      },
    }),
    baseline,
    policy(),
  );
  remoteBytes.fill(7);

  const result = publishCandidate(baseline, candidate, policy());

  assert.deepEqual(result, {
    ok: true,
    changedFiles: [
      "src/a.ts",
      "src/delete.ts",
      "src/new.ts",
      "src/tool.sh",
    ],
  });
  assert.deepEqual(readFileSync(join(root, "src/a.ts")), Buffer.from([0, 1, 2, 255]));
  assert.equal(lstatSync(join(root, "src/delete.ts"), { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(root, "src/new.ts"), "utf8"), "new\n");
  assert.notEqual(lstatSync(join(root, "src/tool.sh")).mode & 0o111, 0);
});

test("publisher preflights every operation before writing any candidate", () => {
  const root = createGitFixture({
    "src/a.ts": "before-a\n",
    "src/b.ts": "before-b\n",
  });
  const baseline = captureWorkspace(root, policy());
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((file) => [file.path, file]),
  );
  files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("accepted-a\n"), false),
  );
  files.set(
    "src/b.ts",
    workspaceFile("src/b.ts", Buffer.from("accepted-b\n"), false),
  );
  const candidate: CandidateSnapshot = {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };
  writeFixtureFile(root, "src/b.ts", "concurrent-b\n");

  const result = publishCandidate(baseline, candidate, policy());

  assert.equal(result.ok, false);
  assert.deepEqual(result.changedFiles, []);
  assert.match(result.conflict ?? "", /src\/b\.ts|冲突|变化/);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before-a\n");
  assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "concurrent-b\n");
});

test("publisher rejects an add collision without changing other files", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(root, policy());
  const replacement = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  const added = workspaceFile("src/new.ts", Buffer.from("new\n"), false);
  const candidate: CandidateSnapshot = {
    files: new Map([...replacement.files, [added.path, added]]),
    operations: [
      ...replacement.operations,
      { kind: "add", file: added },
    ],
  };
  writeFixtureFile(root, "src/new.ts", "collision\n");

  const result = publishCandidate(baseline, candidate, policy());

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
  assert.equal(readFileSync(join(root, "src/new.ts"), "utf8"), "collision\n");
});

test("publisher rejects host symlinks and symlinked parent components", () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "outside/target.ts": "outside\n",
  });
  const baseline = captureWorkspace(root, policy());
  const replacement = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  rmSync(join(root, "src/a.ts"));
  symlinkSync("../outside/target.ts", join(root, "src/a.ts"));

  const symlinkResult = publishCandidate(baseline, replacement, policy());
  assert.equal(symlinkResult.ok, false);
  assert.equal(readFileSync(join(root, "outside/target.ts"), "utf8"), "outside\n");

  rmSync(join(root, "src"), { recursive: true });
  symlinkSync("outside", join(root, "src"));
  const added = workspaceFile("src/new.ts", Buffer.from("new\n"), false);
  const parentResult = publishCandidate(
    baseline,
    {
      files: new Map([[added.path, added]]),
      operations: [{ kind: "add", file: added }],
    },
    policy(),
  );
  assert.equal(parentResult.ok, false);
  assert.equal(
    lstatSync(join(root, "outside/new.ts"), { throwIfNoEntry: false }),
    undefined,
  );
});

test("publisher rejects a host file replaced by a directory", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(root, policy());
  const candidate = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  rmSync(join(root, "src/a.ts"));
  mkdirSync(join(root, "src/a.ts"));

  const result = publishCandidate(baseline, candidate, policy());

  assert.equal(result.ok, false);
  assert.equal(lstatSync(join(root, "src/a.ts")).isDirectory(), true);
});

test("publisher rejects malformed, duplicate, protected, and outside operations", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(root, policy());
  const valid = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  const wrongBefore = workspaceFile(
    "src/a.ts",
    Buffer.from("forged\n"),
    false,
  );
  const protectedFile = workspaceFile(
    "src/protected/gate.ts",
    Buffer.from("x"),
    false,
  );
  const outsideFile = workspaceFile("README.md", Buffer.from("x"), false);
  const candidates: CandidateSnapshot[] = [
    {
      files: valid.files,
      operations: [valid.operations[0]!, valid.operations[0]!],
    },
    {
      files: valid.files,
      operations: [{
        kind: "modify",
        before: wrongBefore,
        file: valid.files.get("src/a.ts")!,
      }],
    },
    {
      files: new Map([[protectedFile.path, protectedFile]]),
      operations: [{ kind: "add", file: protectedFile }],
    },
    {
      files: new Map([[outsideFile.path, outsideFile]]),
      operations: [{ kind: "add", file: outsideFile }],
    },
  ];

  for (const candidate of candidates) {
    const result = publishCandidate(baseline, candidate, policy());
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
  }
});

test("publisher rejects operations that diverge from evaluated candidate files", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(root, policy());
  const accepted = candidateReplacing(baseline, "src/a.ts", "accepted\n");
  const forged = workspaceFile("src/a.ts", Buffer.from("forged\n"), false);

  const divergentBytes: CandidateSnapshot = {
    files: accepted.files,
    operations: [{
      kind: "modify",
      before: baseline.files.get("src/a.ts")!,
      file: forged,
    }],
  };
  const missingOperation: CandidateSnapshot = {
    files: accepted.files,
    operations: [],
  };
  const extra = workspaceFile("src/new.ts", Buffer.from("extra\n"), false);
  const extraOperation: CandidateSnapshot = {
    files: accepted.files,
    operations: [
      ...accepted.operations,
      { kind: "add", file: extra },
    ],
  };

  for (const candidate of [
    divergentBytes,
    missingOperation,
    extraOperation,
  ]) {
    const result = publishCandidate(baseline, candidate, policy());
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
    assert.equal(
      lstatSync(join(root, "src/new.ts"), { throwIfNoEntry: false }),
      undefined,
    );
  }
});

test("publisher reruns host preflight after staging", () => {
  const root = createGitFixture({
    "src/a.ts": "before-a\n",
    "src/b.ts": "before-b\n",
  });
  const baseline = captureWorkspace(root, policy());
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((file) => [file.path, file]),
  );
  files.set("src/a.ts", workspaceFile("src/a.ts", Buffer.from("after-a\n"), false));
  files.set("src/b.ts", workspaceFile("src/b.ts", Buffer.from("after-b\n"), false));
  const candidate: CandidateSnapshot = {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };
  const hooks: PublishHooks = {
    afterStage() {
      writeFixtureFile(root, "src/b.ts", "concurrent-b\n");
    },
  };

  const result = publishCandidate(baseline, candidate, policy(), hooks);

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before-a\n");
  assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "concurrent-b\n");
});

test("publisher rolls back earlier installs when a later install fails", () => {
  const root = createGitFixture({
    "src/a.ts": "before-a\n",
    "src/b.ts": "before-b\n",
  });
  const baseline = captureWorkspace(root, policy());
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((file) => [file.path, file]),
  );
  files.set("src/a.ts", workspaceFile("src/a.ts", Buffer.from("after-a\n"), false));
  files.set("src/b.ts", workspaceFile("src/b.ts", Buffer.from("after-b\n"), false));
  const candidate: CandidateSnapshot = {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };

  const result = publishCandidate(baseline, candidate, policy(), {
    beforeInstall(_path, index) {
      if (index === 1) throw new Error("injected second install failure");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before-a\n");
  assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "before-b\n");
  assert.equal(
    readdirSync(join(root, "src")).some((name) => name.includes(".harness-")),
    false,
  );
});

test("publisher never overwrites an add destination created during commit", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const baseline = captureWorkspace(root, policy());
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((file) => [file.path, file]),
  );
  files.set("src/new.ts", workspaceFile("src/new.ts", Buffer.from("candidate\n"), false));
  const candidate: CandidateSnapshot = {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };

  const result = publishCandidate(baseline, candidate, policy(), {
    beforeInstall(path) {
      if (path === "src/new.ts") {
        writeFixtureFile(root, path, "racer\n");
      }
    },
  });

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(root, "src/new.ts"), "utf8"), "racer\n");
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
});

test("publisher cleans staged temporary siblings when a later write fails", () => {
  const root = createGitFixture({
    "src/a.ts": "before-a\n",
    "src/locked/b.ts": "before-b\n",
  });
  const baseline = captureWorkspace(root, policy());
  const files = new Map(
    agentVisibleFiles(baseline, policy()).map((file) => [file.path, file]),
  );
  files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("accepted-a\n"), false),
  );
  files.set(
    "src/locked/b.ts",
    workspaceFile("src/locked/b.ts", Buffer.from("accepted-b\n"), false),
  );
  const candidate: CandidateSnapshot = {
    files,
    operations: deriveCandidateOperations(baseline, files, policy()),
  };
  chmodSync(join(root, "src/locked"), 0o555);

  try {
    const result = publishCandidate(baseline, candidate, policy());
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before-a\n");
    assert.equal(
      readdirSync(join(root, "src"))
        .some((name) => name.includes(".harness-") && name.endsWith(".tmp")),
      false,
    );
  } finally {
    chmodSync(join(root, "src/locked"), 0o755);
  }
});

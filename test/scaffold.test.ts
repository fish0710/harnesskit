import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProject } from "../src/harness/scaffold.js";

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}`);
}

test("create writes explicit sandbox trust policy", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-"));
  createProject(target);
  const config = JSON.parse(
    readFileSync(join(target, "harness.config.json"), "utf8"),
  ) as {
    sandbox: {
      candidateRoots: string[];
      protectedPaths: string[];
      readOnlyPaths: string[];
    };
  };

  assert.deepEqual(config.sandbox.candidateRoots, [
    "src",
    "test/generated",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]);
  assert.ok(config.sandbox.protectedPaths.includes("contracts"));
  assert.ok(config.sandbox.protectedPaths.includes("test/gates"));
  assert.deepEqual(config.sandbox.readOnlyPaths, [
    "AGENTS.md",
    "docs/specs",
    "docs/plans",
    "docs/reference",
  ]);
});

test("create documents Gate sandbox preflight in AGENTS", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-agents-"));
  createProject(target);
  const agents = readFileSync(join(target, "AGENTS.md"), "utf8");

  assert.match(agents, /harness preflight gate/);
  assert.match(agents, /Gate sandbox/i);
  assert.match(agents, /harness check.*host/i);
  assert.match(agents, /docs\/reference\/harness-runtime\.md/);
});

test("create writes runtime reference for agent-visible Gate environment facts", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-runtime-"));
  createProject(target);
  const runtime = readFileSync(
    join(target, "docs/reference/harness-runtime.md"),
    "utf8",
  );

  assert.match(runtime, /Harness Runtime Reference/);
  assert.match(runtime, /Gate runtime/);
  assert.match(runtime, /Node\.js 22\.14\.0/);
  assert.match(runtime, /npm\/npx 10\.9\.2/);
  assert.match(runtime, /Gate has no Claude/);
  assert.match(runtime, /git, pnpm, yarn, and bun are not installed by default/);
  assert.match(runtime, /source \/usr\/local\/nvm\/nvm\.sh/);
  assert.match(runtime, /Gate network is blocked after `gateSetup`/);
  assert.match(runtime, /127\.0\.0\.1 means the Gate sandbox/);
  assert.match(runtime, /Clean rebuilds are source-reproducibility gates/);
});

test("create initializes git when target is not inside a repository", () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-create-git-"));
  const target = join(parent, "project");
  const result = createProject(target);
  assert.equal(result.git, "initialized");
  assert.equal(existsSync(join(target, ".git")), true);
});

test("create does not initialize a nested git repository inside an existing worktree", () => {
  const repo = mkdtempSync(join(tmpdir(), "harness-create-parent-"));
  git(["init"], repo);
  mkdirSync(join(repo, "nested"), { recursive: true });

  const result = createProject(join(repo, "nested"));

  assert.equal(result.git, "existing");
  assert.equal(existsSync(join(repo, "nested", ".git")), false);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProject } from "../src/harness/scaffold.js";

test("create writes explicit sandbox trust policy", () => {
  const target = mkdtempSync(join(tmpdir(), "harness-create-"));
  createProject(target);
  const config = JSON.parse(
    readFileSync(join(target, "harness.config.json"), "utf8"),
  ) as {
    sandbox: {
      candidateRoots: string[];
      protectedPaths: string[];
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
});

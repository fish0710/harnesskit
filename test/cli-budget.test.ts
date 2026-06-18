import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGenerationBudget } from "../src/harness/budget.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

test("buildGenerationBudget defaults run loop maxMs to 6000 seconds", () => {
  const budget = buildGenerationBudget({}, { kind: "claude" });

  assert.equal(budget.maxMs, 6_000_000);
});

test("buildGenerationBudget accepts manual max-ms override", () => {
  const budget = buildGenerationBudget(
    { "max-ms": "123456" },
    { kind: "command", command: "true" },
  );

  assert.equal(budget.maxMs, 123_456);
});

test("buildGenerationBudget rejects invalid manual budget numbers", () => {
  assert.throws(
    () => buildGenerationBudget(
      { "max-attempts": "Infinity" },
      { kind: "command", command: "true" },
    ),
    /maxAttempts 必须是正整数/,
  );
  assert.throws(
    () => buildGenerationBudget(
      { "max-ms": "0" },
      { kind: "command", command: "true" },
    ),
    /maxMs 必须是正整数/,
  );
});

test("CLI run accepts manual max-ms override", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-budget-"));
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "slow-fail.json"), {
    id: "slow-fail",
    type: "command",
    cmd: "/bin/sh",
    args: ["-c", "sleep 0.05; exit 1"],
  });

  const result = spawnSync(process.execPath, [
    cliPath,
    "run",
    "Budget test.",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
    "--max-attempts",
    "5",
    "--max-ms",
    "1",
  ], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /已升级:stop_for_human .*已耗时/);
});

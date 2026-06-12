import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { gatherStatus } from "../src/harness/status.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function legacyFrozenProject(): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-frozen-"));
  const contractsDir = join(cwd, "contracts");
  mkdirSync(contractsDir);
  writeFileSync(
    join(contractsDir, "legacy.json"),
    JSON.stringify({
      id: "legacy",
      type: "command",
      cmd: "true",
      frozen: true,
      hash: "0123456789abcdef",
    }),
  );
  return { cwd, contractsDir };
}

test("gatherStatus: 旧版冻结哈希报告校验失败而非被篡改", () => {
  const { cwd, contractsDir } = legacyFrozenProject();

  const output = gatherStatus(cwd, contractsDir).join("\n");

  assert.match(output, /校验失败 1 条/);
  assert.doesNotMatch(output, /被篡改/);
});

test("CLI check: 旧版冻结哈希报告校验失败并拒绝放行", () => {
  const { cwd, contractsDir } = legacyFrozenProject();

  const result = spawnSync(process.execPath, [cliPath, "check", "--dir", contractsDir], {
    cwd,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /冻结契约校验失败/);
  assert.doesNotMatch(result.stderr, /冻结契约被篡改/);
});

test("CLI run: 旧版冻结哈希报告校验失败", () => {
  const { cwd, contractsDir } = legacyFrozenProject();

  const result = spawnSync(process.execPath, [cliPath, "run", "test task", "--dir", contractsDir], {
    cwd,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /冻结契约校验失败/);
  assert.doesNotMatch(result.stderr, /冻结契约被篡改/);
});

test("CLI claude run requires Daytona and never falls back to host execution", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-daytona-required-"));
  const contractsDir = join(cwd, "contracts");
  mkdirSync(contractsDir);
  writeFileSync(
    join(contractsDir, "gate.json"),
    JSON.stringify({
      id: "gate",
      type: "command",
      cmd: "true",
    }),
  );
  const environment = { ...process.env };
  delete environment.DAYTONA_API_KEY;

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "test task",
      "--driver",
      "claude",
      "--dir",
      contractsDir,
    ],
    {
      cwd,
      encoding: "utf8",
      env: environment,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAYTONA_API_KEY/);
  assert.doesNotMatch(result.stdout, /claude 完成一轮/);
});

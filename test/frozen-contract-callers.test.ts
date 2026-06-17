import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { gatherStatus } from "../src/harness/status.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function claudeRunProject(): { cwd: string; contractsDir: string } {
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
  return { cwd, contractsDir };
}

function readOnlyRunRecord(cwd: string): Record<string, unknown> {
  const runsDir = join(cwd, ".harness", "runs");
  assert.equal(existsSync(runsDir), true);
  const runFiles = readdirSync(runsDir).filter((file) =>
    file.endsWith(".json")
  );
  assert.equal(runFiles.length, 1);
  return JSON.parse(
    readFileSync(join(runsDir, runFiles[0]!), "utf8"),
  ) as Record<string, unknown>;
}

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
  const { cwd, contractsDir } = claudeRunProject();
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

  const record = readOnlyRunRecord(cwd);
  const observability = record.observability as Record<string, unknown>;
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "error");
  assert.equal(record.task, "test task");
  assert.equal(record.driver, "daytona(claude)");
  assert.equal(observability.enabled, true);
  assert.equal(observability.volumeName, "harness-claude-observability");
  assert.equal(observability.mountPath, "/harness-observability");
  assert.equal(
    observability.runRoot,
    `/harness-observability/runs/${record.runId}`,
  );
  assert.match(record.errorReason as string, /DAYTONA_API_KEY/);
});

test("CLI claude run records disabled Daytona observability when configured off", () => {
  const { cwd, contractsDir } = claudeRunProject();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_DAYTONA_OBSERVABILITY: "0",
  };
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

  const record = readOnlyRunRecord(cwd);
  const observability = record.observability as Record<string, unknown>;
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "error");
  assert.equal(observability.enabled, false);
  assert.equal(observability.backend, "disabled");
  assert.equal(observability.runRoot, undefined);
});

test("CLI claude run records invalid observability configuration failures", () => {
  const { cwd, contractsDir } = claudeRunProject();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "relative/path",
  };

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
  assert.match(result.stderr, /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/);

  const record = readOnlyRunRecord(cwd);
  const observability = record.observability as Record<string, unknown>;
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "error");
  assert.equal(observability.enabled, false);
  assert.match(
    record.errorReason as string,
    /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/,
  );
});

test("CLI claude run records invalid harness config failures", () => {
  const { cwd, contractsDir } = claudeRunProject();
  writeFileSync(join(cwd, "harness.config.json"), "{ invalid json", "utf8");

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
      env: process.env,
    },
  );

  assert.notEqual(result.status, 0);

  const record = readOnlyRunRecord(cwd);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.status, "error");
  assert.match(record.errorReason as string, /JSON/);
});

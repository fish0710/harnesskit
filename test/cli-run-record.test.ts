import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

function projectFixture(): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-run-record-"));
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "smoke.boot.json"), {
    id: "smoke.boot",
    type: "command",
    cmd: "true",
  });
  return { cwd, contractsDir };
}

function latestRunRecord(cwd: string): Record<string, unknown> {
  const runsDir = join(cwd, ".harness", "runs");
  const files = readdirSync(runsDir).filter((file) => file.endsWith(".json")).sort();
  assert.ok(files.length > 0, "expected at least one run record");
  return JSON.parse(readFileSync(join(runsDir, files.at(-1)!), "utf8")) as Record<string, unknown>;
}

function allRunRecords(cwd: string): Array<Record<string, unknown>> {
  const runsDir = join(cwd, ".harness", "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(runsDir, file), "utf8")) as Record<string, unknown>);
}

test("CLI scaffold run writes a unified v3 record with report, logs, and selected contracts", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "record this scaffold task",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /运行记录:/);

  const record = latestRunRecord(cwd);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.kind, "single");
  assert.equal((record.task as { description?: unknown }).description, "record this scaffold task");
  assert.equal(record.driver, "scaffold");
  assert.equal(record.status, "completed");
  assert.deepEqual(record.selectedContracts, ["smoke.boot"]);
  assert.ok(Array.isArray(record.logs));
  assert.match(JSON.stringify(record.logs), /门禁: pass/);
  assert.equal((record.report as { outcome?: unknown }).outcome, "pass");
  assert.deepEqual(record.publication, { ok: true, changedFiles: [] });
});

test("CLI runs list and show expose persisted run records as JSON", () => {
  const { cwd, contractsDir } = projectFixture();

  const run = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "queryable run",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const record = latestRunRecord(cwd);
  const runId = record.runId as string;

  const list = spawnSync(
    process.execPath,
    [cliPath, "runs", "list", "--json"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const listed = JSON.parse(list.stdout) as Array<{ runId?: string; task?: { description?: string } }>;
  assert.deepEqual(
    listed.map((item) => ({ runId: item.runId, task: item.task?.description })),
    [{ runId, task: "queryable run" }],
  );

  const show = spawnSync(
    process.execPath,
    [cliPath, "runs", "show", runId, "--json"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(show.status, 0, show.stderr || show.stdout);
  const shown = JSON.parse(show.stdout) as {
    runId?: string;
    report?: { outcome?: string };
    logs?: string[];
  };
  assert.equal(shown.runId, runId);
  assert.equal(shown.report?.outcome, "pass");
  assert.ok(shown.logs?.some((line) => line.includes("门禁: pass")));
});

test("CLI run records setup failures before an agent can be selected", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "missing command driver args",
      "--driver",
      "command",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--driver command 需要 --agent-cmd/);

  const records = allRunRecords(cwd);
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.kind, "single");
  assert.equal((record.task as { description?: unknown }).description, "missing command driver args");
  assert.equal(record.driver, "daytona(command)");
  assert.equal(record.status, "error");
  assert.equal(record.outcome, "error");
  assert.match(String(record.errorReason), /--driver command 需要 --agent-cmd/);
  assert.deepEqual(record.selectedContracts, []);
});

test("CLI run records contract validation failures", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-run-record-invalid-"));
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "bad.command.json"), {
    id: "bad.command",
    type: "command",
  });

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "load invalid contracts",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /契约规格有问题/);

  const records = allRunRecords(cwd);
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.kind, "single");
  assert.equal(record.status, "error");
  assert.equal(record.outcome, "error");
  assert.match(String(record.errorReason), /契约规格有问题/);
  assert.deepEqual(record.selectedContracts, []);
});

test("CLI run records gate setup failures after selecting contracts", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "bad properties module",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
      "--properties",
      "missing-properties.js",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-properties\.js/);

  const records = allRunRecords(cwd);
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.kind, "single");
  assert.equal(record.status, "error");
  assert.equal(record.outcome, "error");
  assert.match(String(record.errorReason), /missing-properties\.js/);
  assert.deepEqual(record.selectedContracts, ["smoke.boot"]);
});

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

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function initGitFixture(cwd: string): string {
  runGit(["init"], cwd);
  runGit(["config", "user.name", "Harness Tests"], cwd);
  runGit(["config", "user.email", "harness-tests@example.com"], cwd);
  write(join(cwd, "README.md"), "# fixture\n");
  runGit(["add", "README.md"], cwd);
  runGit(["commit", "-m", "chore: init"], cwd);
  return runGit(["rev-parse", "HEAD"], cwd);
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

test("CLI runs resume rejects missing run records", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-missing-"));

  const result = spawnSync(
    process.execPath,
    [cliPath, "runs", "resume", "missing-run"],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /未找到 run 记录: missing-run/);
});

test("CLI help documents runs resume", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /harness runs resume <runId>/);
  assert.match(result.stdout, /--allow-harness-dirty-source/);
});

test("CLI runs resume validates source run before Daytona attach", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-invalid-"));
  writeJson(join(cwd, ".harness", "runs", "bad-run.json"), {
    schemaVersion: 3,
    runId: "bad-run",
    kind: "single",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    repo: { root: cwd, dirty: false },
    task: { description: "resume invalid driver" },
    driver: "daytona(command)",
    status: "completed",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{ attempt: 1, agentSandboxId: "agent-sandbox-a", gateSandboxIds: [] }],
    events: [],
    outcome: "escalated",
  });

  const result = spawnSync(
    process.execPath,
    [cliPath, "runs", "resume", "bad-run"],
    { cwd, encoding: "utf8", env: { ...process.env, DAYTONA_API_KEY: "" } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only daytona\(claude\) runs can be resumed/);
  assert.doesNotMatch(result.stderr + result.stdout, /DAYTONA_API_KEY/);
});

test("CLI runs resume accepts interrupted running Claude records before Daytona attach", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-running-"));
  initGitFixture(cwd);
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "gate-a.json"), {
    id: "gate-a",
    type: "command",
    cmd: "true",
  });
  runGit(["add", "contracts/gate-a.json"], cwd);
  runGit(["commit", "-m", "test: add gate"], cwd);
  const head = runGit(["rev-parse", "HEAD"], cwd);
  writeJson(join(cwd, ".harness", "runs", "running-run.json"), {
    schemaVersion: 3,
    runId: "running-run",
    kind: "single",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    repo: { root: cwd, head, dirty: false },
    task: { description: "resume interrupted claude" },
    driver: "daytona(claude)",
    status: "running",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{
      attempt: 1,
      agentSandboxId: "agent-sandbox-a",
      claudeStreamPath: "/tmp/claude-stream.jsonl",
      claudeConfigDir: "/tmp/claude-config",
      gateSandboxIds: [],
    }],
    events: [],
  });

  const result = spawnSync(
    process.execPath,
    [cliPath, "runs", "resume", "running-run"],
    { cwd, encoding: "utf8", env: { ...process.env, DAYTONA_API_KEY: "" } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /DAYTONA_API_KEY/);
  assert.doesNotMatch(result.stderr + result.stdout, /only escalated/);
});

test("CLI runs resume allows explicit Harness-only dirty source override", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-dirty-allowed-"));
  const head = initGitFixture(cwd);
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "gate-a.json"), {
    id: "gate-a",
    type: "command",
    cmd: "true",
  });
  write(join(cwd, "test", "gates", "gate-a.js"), "console.log('gate');\n");
  writeJson(join(cwd, ".harness", "runs", "dirty-run.json"), {
    schemaVersion: 3,
    runId: "dirty-run",
    kind: "single",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    repo: { root: cwd, head, dirty: true },
    task: { description: "resume dirty harness source" },
    driver: "daytona(claude)",
    status: "running",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{
      attempt: 1,
      agentSandboxId: "agent-sandbox-a",
      claudeStreamPath: "/tmp/claude-stream.jsonl",
      gateSandboxIds: [],
    }],
    events: [],
  });

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "runs",
      "resume",
      "dirty-run",
      "--allow-harness-dirty-source",
    ],
    { cwd, encoding: "utf8", env: { ...process.env, DAYTONA_API_KEY: "" } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /DAYTONA_API_KEY/);
  assert.doesNotMatch(result.stderr + result.stdout, /source run started from a dirty worktree/);

  const resumeRecord = allRunRecords(cwd).find((record) => record.runId !== "dirty-run");
  assert.ok(resumeRecord, "expected resume command to create a new run record");
  const events = resumeRecord.events as Array<{ event?: string; data?: unknown }>;
  const overrideEvent = events.find((event) =>
    event.event === "run.resume.source_dirty_override"
  );
  assert.ok(overrideEvent, "expected dirty-source override audit event");
  assert.deepEqual(
    (overrideEvent.data as { paths?: string[] }).paths?.sort(),
    [
      ".harness/runs/dirty-run.json",
      "contracts/gate-a.json",
      "test/gates/gate-a.js",
    ],
  );
});

test("CLI runs resume rejects dirty-source override with product source changes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-runs-resume-dirty-reject-"));
  const head = initGitFixture(cwd);
  writeJson(join(cwd, "contracts", "gate-a.json"), {
    id: "gate-a",
    type: "command",
    cmd: "true",
  });
  write(join(cwd, "src", "app.ts"), "export const app = true;\n");
  writeJson(join(cwd, ".harness", "runs", "dirty-run.json"), {
    schemaVersion: 3,
    runId: "dirty-run",
    kind: "single",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    repo: { root: cwd, head, dirty: true },
    task: { description: "resume dirty product source" },
    driver: "daytona(claude)",
    status: "running",
    observability: {
      enabled: false,
      backend: "disabled",
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
    },
    selectedContracts: ["gate-a"],
    attempts: [{
      attempt: 1,
      agentSandboxId: "agent-sandbox-a",
      claudeStreamPath: "/tmp/claude-stream.jsonl",
      gateSandboxIds: [],
    }],
    events: [],
  });

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "runs",
      "resume",
      "dirty-run",
      "--allow-harness-dirty-source",
    ],
    { cwd, encoding: "utf8", env: { ...process.env, DAYTONA_API_KEY: "" } },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /current worktree has non-Harness source changes; retained dirty-source resume is not safe: src\/app\.ts/,
  );
  assert.doesNotMatch(result.stderr + result.stdout, /DAYTONA_API_KEY/);
});

test("CLI scaffold run with --verbose writes diagnostic JSONL and records its path", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "verbose scaffold task",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
      "--verbose",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /debug run\.setup/);
  assert.match(result.stdout, /Diagnostic log:/);

  const record = latestRunRecord(cwd);
  assert.equal(typeof record.diagnosticLogPath, "string");
  const diagnosticLogPath = record.diagnosticLogPath as string;
  assert.equal(existsSync(diagnosticLogPath), true);
  const entries = readFileSync(diagnosticLogPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { phase?: string; message?: string });
  assert.ok(entries.some((entry) =>
    entry.phase === "run.setup" && entry.message === "agent selected"
  ));
  assert.ok(entries.some((entry) =>
    entry.phase === "loop" && entry.message === "attempt start"
  ));
});

test("CLI scaffold run without --verbose does not write diagnostic log path", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "quiet scaffold task",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
    ],
    { cwd, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /debug run\.setup/);
  assert.doesNotMatch(result.stdout, /Diagnostic log:/);

  const record = latestRunRecord(cwd);
  assert.equal(record.diagnosticLogPath, undefined);
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

test("CLI verbose setup failure records error diagnostic entry", () => {
  const { cwd, contractsDir } = projectFixture();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "verbose setup failure",
      "--driver",
      "scaffold",
      "--dir",
      contractsDir,
      "--properties",
      "missing-properties.js",
      "--verbose",
    ],
    { cwd, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const record = latestRunRecord(cwd);
  assert.equal(record.status, "error");
  assert.equal(typeof record.diagnosticLogPath, "string");
  const entries = readFileSync(record.diagnosticLogPath as string, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { level?: string; phase?: string; message?: string });
  assert.ok(entries.some((entry) =>
    entry.level === "error" &&
    entry.phase === "run.setup" &&
    entry.message === "run failed"
  ));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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

function projectFixture(options?: {
  includeFailingUnselected?: boolean;
  config?: unknown;
}): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-run-"));
  const contractsDir = join(cwd, "contracts");

  writeJson(join(contractsDir, "smoke.boot.json"), {
    id: "smoke.boot",
    type: "command",
    stage: "smoke",
    cmd: "true",
  });
  writeJson(join(contractsDir, "domain.model-boundary.json"), {
    id: "domain.model-boundary",
    type: "command",
    stage: "domain",
    cmd: "true",
  });
  if (options?.includeFailingUnselected) {
    writeJson(join(contractsDir, "unselected.fail.json"), {
      id: "unselected.fail",
      type: "command",
      stage: "unselected",
      cmd: "false",
    });
  }
  if (options?.config !== undefined) {
    writeJson(join(cwd, "harness.config.json"), options.config);
  }

  return { cwd, contractsDir };
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("CLI run with explicit task keeps single-task behavior even when config has tasks", () => {
  const { cwd, contractsDir } = projectFixture({
    config: {
      tasks: [{ id: "configured", task: "Configured task." }],
    },
  });

  const result = runCli(cwd, [
    "run",
    "Explicit task.",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /task="Explicit task\."/);
  assert.doesNotMatch(result.stdout, /series/);
});

test("CLI run without task consumes configured task series", () => {
  const { cwd, contractsDir } = projectFixture({
    includeFailingUnselected: true,
    config: {
      series: { id: "order-refactor" },
      taskDefaults: { gate: { contracts: ["smoke.boot"] } },
      autoCommit: { enabled: false },
      tasks: [
        { id: "one", task: "First task." },
        {
          id: "two",
          task: "Second task.",
          gate: { contracts: ["domain.model-boundary"] },
        },
      ],
    },
  });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /harness series · id=order-refactor · tasks=2/);
  assert.match(result.stdout, /\[1\/2\] one/);
  assert.match(result.stdout, /\[2\/2\] two/);

  const ledger = JSON.parse(
    readFileSync(join(cwd, ".harness/series/order-refactor.json"), "utf8"),
  ) as {
    status?: unknown;
    tasks?: Array<{ id?: unknown; status?: unknown }>;
  };
  assert.equal(ledger.status, "completed");
  assert.deepEqual(
    ledger.tasks?.map((task) => ({ id: task.id, status: task.status })),
    [
      { id: "one", status: "completed" },
      { id: "two", status: "completed" },
    ],
  );
});

test("CLI run without task errors when config has no task series", () => {
  const { cwd, contractsDir } = projectFixture({ config: {} });

  const result = runCli(cwd, [
    "run",
    "--driver",
    "scaffold",
    "--dir",
    contractsDir,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法: harness run "<task 描述>"/);
  assert.match(result.stderr, /或在 harness\.config\.json 配置 tasks/);
});

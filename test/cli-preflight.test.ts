import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { GatePreflightReport } from "../src/harness/preflight.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

function projectFixture(): { cwd: string; contractsDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-preflight-"));
  const contractsDir = join(cwd, "contracts");
  writeJson(join(contractsDir, "smoke.command.json"), {
    id: "smoke.command",
    type: "command",
    stage: "smoke",
    cmd: "true",
  });
  writeJson(join(contractsDir, "domain.command.json"), {
    id: "domain.command",
    type: "command",
    stage: "domain",
    cmd: "true",
  });
  writeJson(join(cwd, "harness.config.json"), {
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts", "harness.config.json"],
      gateSetup: ["nvm use 20"],
    },
  });
  return { cwd, contractsDir };
}

test("CLI preflight gate reports static readiness errors without requiring Daytona credentials", () => {
  const { cwd, contractsDir } = projectFixture();
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "preflight",
      "gate",
      "--json",
      "--stage",
      "smoke",
      "--dir",
      contractsDir,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, DAYTONA_API_KEY: "" },
    },
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /DAYTONA_API_KEY/);
  const report = JSON.parse(result.stdout) as GatePreflightReport;
  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.selectedContracts, ["smoke.command"]);
  assert.deepEqual(report.remoteContracts, ["smoke.command"]);
  assert.deepEqual(report.hostLocalContracts, []);
  assert.deepEqual(
    report.readinessErrors.map((finding) => finding.id),
    ["gateSetup.1.nvm"],
  );
  assert.equal(report.sandbox, undefined);
});

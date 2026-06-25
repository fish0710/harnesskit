import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadContracts, verifyFrozen } from "../src/contracts.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import {
  loadTaskSeriesConfig,
  selectTaskContracts,
} from "../src/harness/series.js";

const exampleRoot = (name: string) => join(process.cwd(), "examples", name);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadExample(name: string) {
  const root = exampleRoot(name);
  const config = readJson(join(root, "harness.config.json"));
  const { contracts, issues } = loadContracts(join(root, "contracts"));
  return { root, config, contracts, issues };
}

function assertDaytonaReadme(name: string, commandPattern: RegExp): void {
  const readme = readText(join(exampleRoot(name), "README.md"));
  for (const envName of [
    "DAYTONA_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
  ]) {
    assert.match(readme, new RegExp(envName), `${name} documents ${envName}`);
  }
  assert.match(readme, /npm run build/, `${name} builds the source checkout CLI`);
  assert.match(readme, /node dist\/src\/cli\.js run/, `${name} uses source checkout CLI`);
  assert.match(readme, /--driver claude/, `${name} uses the Claude driver`);
  assert.match(readme, commandPattern, `${name} documents its exact run command`);
  assert.match(readme, /Agent sandbox/, `${name} explains the Agent sandbox`);
  assert.match(readme, /Gate sandbox/, `${name} explains the Gate sandbox`);
  assert.match(readme, /\.harness\/runs/, `${name} explains run records`);
}

test("Daytona Claude examples validate contracts and README run instructions", () => {
  for (const name of [
    "resume-health-port",
    "daytona-cli-tdd",
    "daytona-task-series",
  ]) {
    const { contracts, issues } = loadExample(name);
    assert.deepEqual(issues, [], `${name} contracts should parse`);
    for (const contract of contracts) {
      const frozen = verifyFrozen(contract);
      assert.equal(frozen.ok, true, frozen.message);
    }
  }

  assertDaytonaReadme(
    "resume-health-port",
    /--dir examples\/resume-health-port\/contracts --config examples\/resume-health-port\/harness\.config\.json/,
  );
  assertDaytonaReadme(
    "daytona-cli-tdd",
    /--dir examples\/daytona-cli-tdd\/contracts --config examples\/daytona-cli-tdd\/harness\.config\.json/,
  );
  assertDaytonaReadme(
    "daytona-task-series",
    /--driver claude --dir examples\/daytona-task-series\/contracts --config examples\/daytona-task-series\/harness\.config\.json/,
  );
});

test("Daytona Claude examples keep agent mutation scope narrow", () => {
  const cases = [
    {
      name: "resume-health-port",
      candidateRoots: ["examples/resume-health-port/src"],
      readOnlyPaths: [
        "examples/resume-health-port/TASK.md",
        "examples/resume-health-port/package.json",
      ],
      protectedPaths: [
        "examples/resume-health-port/contracts",
        "examples/resume-health-port/harness.config.json",
      ],
    },
    {
      name: "daytona-cli-tdd",
      candidateRoots: ["examples/daytona-cli-tdd/bin"],
      readOnlyPaths: [
        "examples/daytona-cli-tdd/TASK.md",
        "examples/daytona-cli-tdd/package.json",
        "examples/daytona-cli-tdd/test",
      ],
      protectedPaths: [
        "examples/daytona-cli-tdd/contracts",
        "examples/daytona-cli-tdd/harness.config.json",
      ],
    },
    {
      name: "daytona-task-series",
      candidateRoots: ["examples/daytona-task-series/src"],
      readOnlyPaths: [
        "examples/daytona-task-series/TASK.md",
        "examples/daytona-task-series/package.json",
        "examples/daytona-task-series/test",
      ],
      protectedPaths: [
        "examples/daytona-task-series/contracts",
        "examples/daytona-task-series/harness.config.json",
      ],
    },
  ];

  for (const item of cases) {
    const { config } = loadExample(item.name);
    const policy = loadSandboxPolicy(config);
    assert.deepEqual(policy.candidateRoots, item.candidateRoots);
    assert.deepEqual(policy.readOnlyPaths, item.readOnlyPaths);
    for (const protectedPath of item.protectedPaths) {
      assert.ok(
        policy.protectedPaths.includes(protectedPath),
        `${item.name} protects ${protectedPath}`,
      );
    }
  }
});

test("Daytona task series selects task-specific contracts", () => {
  const { config, contracts } = loadExample("daytona-task-series");
  const series = loadTaskSeriesConfig(config)!;
  assert.equal(series.seriesId, "daytona-order-series");
  assert.equal(series.tasks.length, 2);
  assert.equal(series.autoCommit.enabled, false);

  const first = selectTaskContracts({
    contracts,
    task: series.tasks[0]!,
    defaults: series.taskDefaults,
  }).map((contract) => contract.id);
  const second = selectTaskContracts({
    contracts,
    task: series.tasks[1]!,
    defaults: series.taskDefaults,
  }).map((contract) => contract.id);

  assert.deepEqual(first, ["domain.model"]);
  assert.deepEqual(second, ["domain.model", "order.service"]);
});

test("Daytona example files referenced by contracts exist", () => {
  const requiredPaths = [
    "examples/resume-health-port/src/server.js",
    "examples/daytona-cli-tdd/bin/quote.js",
    "examples/daytona-cli-tdd/test/quote-cli.test.js",
    "examples/daytona-task-series/src/domain-model.js",
    "examples/daytona-task-series/src/order-service.js",
    "examples/daytona-task-series/test/domain-model.test.js",
    "examples/daytona-task-series/test/order-service.test.js",
  ];

  for (const path of requiredPaths) {
    assert.equal(existsSync(join(process.cwd(), path)), true, path);
  }
});

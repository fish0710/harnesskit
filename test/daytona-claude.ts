import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { GateCore } from "../src/gate.js";
import { runLoop } from "../src/harness/run.js";
import { createDaytonaSdkProvider } from "../src/harness/sandbox/daytona.js";
import { createDaytonaRunEnvironment } from "../src/harness/sandbox/environment.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import type {
  SandboxCreateRequest,
  SandboxProvider,
} from "../src/harness/sandbox/types.js";
import { commandPlugin } from "../src/plugins/command.js";

function createGitFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-daytona-integration-"));
  const destination = join(root, "src/result.txt");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, "broken\n");
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c", "user.name=Harness Integration",
      "-c", "user.email=harness@example.invalid",
      "commit", "-m", "fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

export async function runDaytonaIntegration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (environment.RUN_DAYTONA_INTEGRATION !== "1") {
    console.log(
      "SKIP Daytona integration: set RUN_DAYTONA_INTEGRATION=1",
    );
    return;
  }

  const roles: SandboxCreateRequest["role"][] = [];
  const sdkProvider = createDaytonaSdkProvider(environment);
  const provider: SandboxProvider = {
    async create(request) {
      roles.push(request.role);
      return sdkProvider.create(request);
    },
  };
  const root = createGitFixture();
  const policy = loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts", ".harness"],
      retainOnFailure: false,
    },
  });
  const runEnvironment = createDaytonaRunEnvironment({
    provider,
    root,
    policy,
    agent: { kind: "claude" },
    environment,
  });

  const outcome = await runLoop({
    task: "Replace src/result.txt with exactly: passed and no trailing newline.",
    contracts: [{
      id: "integration.result",
      type: "command",
      cmd: "sh",
      args: [
        "-c",
        "bytes=$(wc -c < src/result.txt) || exit 1; " +
          "value=$(cat src/result.txt) || exit 1; " +
          "[ \"$bytes\" -eq 6 ] && [ \"$value\" = passed ] && exit 0; " +
          "printf 'bytes=%s value=<%s> hex=' \"$bytes\" \"$value\"; " +
          "od -An -tx1 src/result.txt",
      ],
    }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment: runEnvironment,
    onLog: (line) => console.log(line),
    budget: {
      maxAttempts: 1,
      maxTokens: 1e9,
      maxMs: 10 * 60 * 1000,
      contextThreshold: 0.99,
      repeatWallThreshold: 3,
    },
  });

  if (outcome.outcome !== "ready_for_mr") {
    throw new Error(
      `Daytona integration failed: ${outcome.outcome} ${
        outcome.action?.reason ?? ""
      }; report=${JSON.stringify(outcome.report)}`,
    );
  }
  if (roles.filter((role) => role === "agent").length !== 1) {
    throw new Error(`Expected one agent sandbox, got ${roles.join(",")}`);
  }
  if (roles.filter((role) => role === "gate").length !== 1) {
    throw new Error(`Expected one gate sandbox, got ${roles.join(",")}`);
  }
  console.log("PASS Daytona agent/gate integration");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    await runDaytonaIntegration();
  } catch (error) {
    console.error(
      "Daytona integration failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

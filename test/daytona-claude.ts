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
import { requireAgentSnapshot } from "../src/harness/sandbox/toolchain.js";
import type {
  SandboxCreateRequest,
  SandboxPolicy,
  SandboxProvider,
} from "../src/harness/sandbox/types.js";
import { commandPlugin } from "../src/plugins/command.js";

export function integrationPolicy(): SandboxPolicy {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src", "package.json", "package-lock.json"],
      protectedPaths: ["contracts", ".harness"],
      agentSetup: ["npm install"],
      retainOnFailure: false,
    },
  });
}

export function createGitFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-daytona-integration-"));
  const destination = join(root, "src/result.txt");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, "broken\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "harness-daytona-integration-fixture",
      version: "1.0.0",
      private: true,
    }, null, 2) + "\n",
  );
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

  const agentSnapshot = requireAgentSnapshot(environment);
  const createRequests: SandboxCreateRequest[] = [];
  const sdkProvider = createDaytonaSdkProvider(environment);
  const provider: SandboxProvider = {
    async create(request) {
      createRequests.push({
        ...request,
        envVars: { ...request.envVars },
      });
      return sdkProvider.create(request);
    },
  };
  const root = createGitFixture();
  const policy = integrationPolicy();
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
  const agentRequests = createRequests.filter((request) =>
    request.role === "agent"
  );
  const gateRequests = createRequests.filter((request) =>
    request.role === "gate"
  );
  const roles = createRequests.map((request) => request.role);
  if (agentRequests.length !== 1) {
    throw new Error(`Expected one agent sandbox, got ${roles.join(",")}`);
  }
  if (gateRequests.length !== 1) {
    throw new Error(`Expected one gate sandbox, got ${roles.join(",")}`);
  }
  if (agentRequests[0]?.snapshot !== agentSnapshot) {
    throw new Error(
      `Expected agent snapshot ${agentSnapshot}, got ${
        agentRequests[0]?.snapshot ?? "undefined"
      }`,
    );
  }
  if (gateRequests[0]?.snapshot !== undefined) {
    throw new Error(
      `Expected gate snapshot undefined, got ${gateRequests[0]?.snapshot}`,
    );
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

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Daytona } from "@daytona/sdk";

import {
  DAYTONA_AGENT_SNAPSHOT,
  DAYTONA_GATE_IMAGE,
  DAYTONA_GATE_LATEST_SNAPSHOT,
  DAYTONA_GATE_REGISTRY_IMAGE,
} from "../harness/sandbox/toolchain.js";
import {
  configureLocalDaytonaProxy,
  getDaytonaConfig,
  rewriteRemoteToolboxProxy,
} from "../harness/sandbox/daytona.js";

type DaytonaSnapshot = Awaited<ReturnType<Daytona["snapshot"]["get"]>>;

type SnapshotIdentity = {
  id?: string;
  name: string;
  imageName?: string;
  buildInfo?: {
    dockerfileContent?: string;
  };
  state: string;
  errorReason?: string | null;
};

type SnapshotSourceSandbox = Awaited<ReturnType<Daytona["create"]>>;

export const DAYTONA_GATE_DOCKERFILE = "images/daytona/gate/Dockerfile";

export function readGateDockerfile(): string {
  return readFileSync(DAYTONA_GATE_DOCKERFILE, "utf8");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildGateImageCommands(
  runner: string,
  context: string,
): Array<[string, string[]]> {
  const quotedContext = quoteShell(context);
  const quotedDockerfileDir = quoteShell("images/daytona/gate");
  const prepareContext =
    `rm -rf ${quotedContext} && mkdir -p ${quotedContext}`;
  const transferContext =
    `COPYFILE_DISABLE=1 tar -C ${quotedDockerfileDir} -cf - . | ` +
    `docker exec -i ${quoteShell(runner)} sh -lc ` +
    quoteShell(`${prepareContext} && tar -C ${quotedContext} -xf -`);
  return [
    ["sh", ["-lc", transferContext]],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "build",
        "--pull=false",
        "-t",
        DAYTONA_GATE_IMAGE,
        context,
      ],
    ],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "/bin/sh",
        DAYTONA_GATE_IMAGE,
        "-lc",
        "test -x /usr/bin/bash && node --version && " +
          "npm --version && npx --version && python3 --version && " +
          "curl --version",
      ],
    ],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "tag",
        DAYTONA_GATE_IMAGE,
        DAYTONA_GATE_REGISTRY_IMAGE,
      ],
    ],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "push",
        DAYTONA_GATE_REGISTRY_IMAGE,
      ],
    ],
  ];
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ` +
        `${result.status ?? "unknown"}`,
    );
  }
}

function cleanupRemoteContext(runner: string, context: string): void {
  const result = spawnSync(
    "docker",
    ["exec", runner, "sh", "-lc", `rm -rf ${quoteShell(context)}`],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(`Failed to clean remote image context: ${result.error}`);
  } else if (result.status !== 0) {
    console.error(
      `Failed to clean remote image context; docker exited ` +
        `${result.status ?? "unknown"}`,
    );
  }
}

function shouldBuildWithRunner(environment: NodeJS.ProcessEnv, apiUrl: string) {
  if (environment.HARNESS_DAYTONA_RUNNER_BUILD === "1") return true;
  if (environment.HARNESS_DAYTONA_SKIP_RUNNER_BUILD === "1") return false;
  const hostname = new URL(apiUrl).hostname;
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const shaped = error as Error & {
    statusCode?: number;
    response?: { status?: number };
  };
  return (
    shaped.statusCode === 404 ||
    shaped.response?.status === 404 ||
    error.name === "DaytonaNotFoundError"
  );
}

function snapshotFailure(snapshot: SnapshotIdentity, reason: string): Error {
  const errorReason = snapshot.errorReason
    ? `: ${snapshot.errorReason}`
    : "";
  return new Error(
    `Snapshot ${snapshot.name} ${reason} in state ${snapshot.state}` +
      errorReason,
  );
}

function isTerminalFailure(snapshot: SnapshotIdentity): boolean {
  return snapshot.state === "error" || snapshot.state === "build_failed";
}

function assertCompatibleGateSnapshot(snapshot: SnapshotIdentity): void {
  const matchesRegistryImage =
    snapshot.imageName === DAYTONA_GATE_REGISTRY_IMAGE;
  const matchesBuildInfo =
    snapshot.buildInfo?.dockerfileContent === readGateDockerfile();
  if (!matchesRegistryImage && !matchesBuildInfo) {
    throw new Error(
      `Existing Snapshot ${snapshot.name} does not match ` +
        `${DAYTONA_GATE_REGISTRY_IMAGE} or current Gate Dockerfile; ` +
        `delete or replace the latest Snapshot before publishing`,
    );
  }
}

async function ensureLatestGateSnapshot(
  daytona: Daytona,
  apiUrl: string,
): Promise<DaytonaSnapshot> {
  try {
    const snapshot = await daytona.snapshot.get(DAYTONA_GATE_LATEST_SNAPSHOT);
    if (process.env.HARNESS_DAYTONA_REPLACE_LATEST === "1") {
      await daytona.snapshot.delete(snapshot);
      await waitForSnapshotDeleted(daytona, DAYTONA_GATE_LATEST_SNAPSHOT);
    } else if (snapshot.state === "active") {
      return snapshot;
    } else {
      throw new Error(
        `Snapshot ${DAYTONA_GATE_LATEST_SNAPSHOT} is ${snapshot.state}. ` +
          `Set HARNESS_DAYTONA_REPLACE_LATEST=1 to replace it.`,
      );
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await createLatestGateFromAgentRuntime(daytona, apiUrl);
  const snapshot = await daytona.snapshot.get(DAYTONA_GATE_LATEST_SNAPSHOT);
  if (snapshot.state === "active") return snapshot;
  throw snapshotFailure(snapshot, "was not active after copy");
}

async function waitForSnapshotDeleted(
  daytona: Daytona,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      await daytona.snapshot.get(name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Snapshot ${name} was not deleted before deadline`);
}

async function createLatestGateFromAgentRuntime(
  daytona: Daytona,
  apiUrl: string,
): Promise<void> {
  const source = await daytona.snapshot.get(DAYTONA_AGENT_SNAPSHOT);
  if (source.state !== "active") {
    throw snapshotFailure(source, "cannot be used as Gate runtime source");
  }
  let sandbox: SnapshotSourceSandbox | undefined;
  try {
    sandbox = await daytona.create(
      {
        snapshot: DAYTONA_AGENT_SNAPSHOT,
        ephemeral: true,
      },
      { timeout: 120 },
    );
    rewriteRemoteToolboxProxy(sandbox, apiUrl);
    const result = await sandbox.process.executeCommand(
      "sudo rm -rf /opt/claude-code /usr/local/bin/claude " +
        "$HOME/.claude $HOME/.config/claude*; " +
        "test -x /usr/bin/bash && node --version && npm --version && " +
        "npx --version && python3 --version && curl --version && " +
        "! command -v claude",
    );
    const output = result.result.trim();
    if (result.exitCode !== 0) {
      throw new Error(
        `Gate source cleanup failed with exit ${result.exitCode}: ` +
          (output || "(no output)"),
      );
    }
    await sandbox._experimental_createSnapshot(
      DAYTONA_GATE_LATEST_SNAPSHOT,
      10 * 60,
    );
  } finally {
    if (sandbox) {
      await daytona.delete(sandbox).catch(() => undefined);
    }
  }
}

async function verifyGateSnapshotToolchain(
  daytona: Daytona,
  apiUrl: string,
): Promise<void> {
  const sandbox = await daytona.create(
    {
      snapshot: DAYTONA_GATE_LATEST_SNAPSHOT,
      ephemeral: true,
    },
    { timeout: 120 },
  );
  rewriteRemoteToolboxProxy(sandbox, apiUrl);
  try {
    const result = await sandbox.process.executeCommand(
      "test -x /usr/bin/bash && node --version && npm --version && " +
        "npx --version && python3 --version && curl --version && " +
        "! command -v claude",
    );
    const output = result.result.trim();
    if (result.exitCode !== 0) {
      throw new Error(
        `Gate snapshot toolchain preflight failed with exit ` +
          `${result.exitCode}: ${output || "(no output)"}`,
      );
    }
  } finally {
    await daytona.delete(sandbox);
  }
}

export async function main(): Promise<void> {
  const runner = process.env.DAYTONA_RUNNER_CONTAINER || "daytona-runner-1";
  const context = `/tmp/harness-gate-image-${process.pid}`;
  configureLocalDaytonaProxy(process.env);
  const config = getDaytonaConfig(process.env);
  try {
    if (shouldBuildWithRunner(process.env, config.apiUrl)) {
      for (const [command, args] of buildGateImageCommands(runner, context)) {
        runCommand(command, args);
      }
    }

    const daytona = new Daytona(config);
    await ensureLatestGateSnapshot(daytona, config.apiUrl);
    await verifyGateSnapshotToolchain(daytona, config.apiUrl);
    console.log(
      `export HARNESS_DAYTONA_GATE_SNAPSHOT=${DAYTONA_GATE_LATEST_SNAPSHOT}`,
    );
  } finally {
    if (shouldBuildWithRunner(process.env, config.apiUrl)) {
      cleanupRemoteContext(runner, context);
    }
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

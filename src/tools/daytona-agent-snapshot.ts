import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Daytona, Image } from "@daytona/sdk";

import {
  assertClaudeToolchain,
  CLAUDE_TOOLCHAIN_PREFLIGHT,
  DAYTONA_AGENT_IMAGE,
  DAYTONA_AGENT_REGISTRY_IMAGE,
  DAYTONA_AGENT_SNAPSHOT,
} from "../harness/sandbox/toolchain.js";
import {
  configureLocalDaytonaProxy,
  getDaytonaConfig,
  rewriteRemoteToolboxProxy,
} from "../harness/sandbox/daytona.js";

type DaytonaSnapshot = Awaited<ReturnType<Daytona["snapshot"]["get"]>>;

type SnapshotIdentity = {
  name: string;
  imageName?: string;
  buildInfo?: {
    dockerfileContent?: string;
  };
  state: string;
  errorReason?: string | null;
};

export const DAYTONA_AGENT_DOCKERFILE =
  "images/daytona/claude/Dockerfile";

export function readAgentDockerfile(): string {
  return readFileSync(DAYTONA_AGENT_DOCKERFILE, "utf8");
}

export function assertCompatibleSnapshot(
  snapshot: SnapshotIdentity,
): void {
  const matchesRegistryImage =
    snapshot.imageName === DAYTONA_AGENT_REGISTRY_IMAGE;
  const matchesBuildInfo =
    snapshot.buildInfo?.dockerfileContent === readAgentDockerfile();
  if (!matchesRegistryImage && !matchesBuildInfo) {
    throw new Error(
      `Existing immutable Snapshot ${snapshot.name} does not match ` +
        `${DAYTONA_AGENT_REGISTRY_IMAGE} or current Dockerfile; ` +
        `publish a new revision such as r2`,
    );
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildImageCommands(
  runner: string,
  context: string,
): Array<[string, string[]]> {
  const quotedContext = quoteShell(context);
  const quotedDockerfileDir = quoteShell("images/daytona/claude");
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
        DAYTONA_AGENT_IMAGE,
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
        DAYTONA_AGENT_IMAGE,
        "-lc",
        "node --version && npm --version && npx --version && claude --version",
      ],
    ],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "tag",
        DAYTONA_AGENT_IMAGE,
        DAYTONA_AGENT_REGISTRY_IMAGE,
      ],
    ],
    [
      "docker",
      [
        "exec",
        runner,
        "docker",
        "push",
        DAYTONA_AGENT_REGISTRY_IMAGE,
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

function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const shaped = error as Error & {
    statusCode?: number;
    response?: { status?: number; data?: { message?: string } };
  };
  return (
    shaped.statusCode === 403 ||
    shaped.response?.status === 403 ||
    error.message === "Access denied" ||
    shaped.response?.data?.message === "Access denied"
  );
}

export function explainSnapshotCreateError(error: unknown): Error {
  if (!isAccessDenied(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error(
    `Daytona refused to create Snapshot ${DAYTONA_AGENT_SNAPSHOT}. ` +
      `The configured DAYTONA_API_KEY needs write:snapshots permission. ` +
      `If publishing through a Daytona registry, the organization also needs ` +
      `a configured Docker registry and the key needs registry write access.`,
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

async function ensureSnapshot(daytona: Daytona): Promise<DaytonaSnapshot> {
  let snapshot: DaytonaSnapshot;
  try {
    snapshot = await daytona.snapshot.get(DAYTONA_AGENT_SNAPSHOT);
    assertCompatibleSnapshot(snapshot);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      snapshot = await daytona.snapshot.create(
        {
          name: DAYTONA_AGENT_SNAPSHOT,
          image: Image.fromDockerfile(DAYTONA_AGENT_DOCKERFILE),
        },
        {
          timeout: 10 * 60,
          onLogs: (line) => console.log(line),
        },
      );
    } catch (createError) {
      throw explainSnapshotCreateError(createError);
    }
    assertCompatibleSnapshot(snapshot);
  }

  if (snapshot.state === "active") return snapshot;
  if (isTerminalFailure(snapshot)) {
    throw snapshotFailure(snapshot, "cannot be activated");
  }

  snapshot = await daytona.snapshot.activate(snapshot);
  return pollActiveSnapshot(daytona, snapshot);
}

async function pollActiveSnapshot(
  daytona: Daytona,
  initial: DaytonaSnapshot,
): Promise<DaytonaSnapshot> {
  let snapshot = initial;
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    if (snapshot.state === "active") return snapshot;
    if (isTerminalFailure(snapshot)) {
      throw snapshotFailure(snapshot, "failed to activate");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    snapshot = await daytona.snapshot.get(DAYTONA_AGENT_SNAPSHOT);
  }
  throw snapshotFailure(snapshot, "did not become active before deadline");
}

async function verifySnapshotToolchain(
  daytona: Daytona,
  apiUrl: string,
): Promise<void> {
  const sandbox = await daytona.create(
    {
      snapshot: DAYTONA_AGENT_SNAPSHOT,
      ephemeral: true,
    },
    { timeout: 120 },
  );
  rewriteRemoteToolboxProxy(sandbox, apiUrl);
  try {
    const result = await sandbox.process.executeCommand(
      CLAUDE_TOOLCHAIN_PREFLIGHT,
    );
    assertClaudeToolchain({
      exitCode: result.exitCode,
      stdout: result.result,
      stderr: "",
    });
  } finally {
    await daytona.delete(sandbox);
  }
}

export async function main(): Promise<void> {
  const runner = process.env.DAYTONA_RUNNER_CONTAINER || "daytona-runner-1";
  const context = `/tmp/harness-agent-image-${process.pid}`;
  try {
    for (const [command, args] of buildImageCommands(runner, context)) {
      runCommand(command, args);
    }

    configureLocalDaytonaProxy(process.env);
    const config = getDaytonaConfig(process.env);
    const daytona = new Daytona(config);
    await ensureSnapshot(daytona);
    await verifySnapshotToolchain(daytona, config.apiUrl);
    console.log(`export HARNESS_DAYTONA_AGENT_SNAPSHOT=${DAYTONA_AGENT_SNAPSHOT}`);
  } finally {
    cleanupRemoteContext(runner, context);
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

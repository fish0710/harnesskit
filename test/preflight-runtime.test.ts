import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { GateCore } from "../src/gate.js";
import { runGatePreflight } from "../src/harness/preflight.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import type {
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxHandle,
  SandboxProvider,
  WorkspaceFile,
} from "../src/harness/sandbox/types.js";
import { workspaceFile, type RemoteWorkspace } from "../src/harness/sandbox/workspace.js";
import { commandPlugin } from "../src/plugins/command.js";
import { httpPlugin } from "../src/plugins/http.js";
import type { Contract, RunContext } from "../src/types.js";

const REMOTE_ROOT = "/workspace/candidate";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TEST = "'/usr/bin/env' '--' 'node' 'test.js'";
const HTTP_EVIDENCE_MARKER = "HARNESS_HTTP_EVIDENCE ";

function createGitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-preflight-runtime-"));
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Harness Test",
      "-c",
      "user.email=harness@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

function policy(gateSetup: string[] = []) {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src", "package.json"],
      protectedPaths: ["contracts"],
      gateSetup,
    },
  });
}

interface ExecuteCall {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | undefined;
}

class RecordingGateHandle implements SandboxHandle {
  readonly files = new Map<string, WorkspaceFile>();
  readonly uploads: Array<{ files: string[]; remoteRoot: string }> = [];
  readonly verifies: Array<{ files: string[]; remoteRoot: string }> = [];
  readonly commands: string[] = [];
  readonly executeCalls: ExecuteCall[] = [];
  readonly networkBlocks: boolean[] = [];
  deleted = 0;

  constructor(
    readonly id: string,
    private readonly exitCodes: Record<string, number>,
    private readonly outputs: Record<string, string> = {},
    private readonly deleteError?: Error,
  ) {}

  async upload(files: WorkspaceFile[], remoteRoot: string): Promise<void> {
    this.uploads.push({ files: files.map((file) => file.path).sort(), remoteRoot });
    for (const file of files) {
      this.files.set(
        file.path,
        workspaceFile(file.path, file.content, file.executable),
      );
    }
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) this.files.delete(path);
  }

  async verify(files: WorkspaceFile[], remoteRoot: string): Promise<void> {
    this.verifies.push({ files: files.map((file) => file.path).sort(), remoteRoot });
  }

  workspace(): RemoteWorkspace {
    return {
      list: async () =>
        [...this.files.values()].map((file) => ({
          path: file.path,
          kind: "file" as const,
          size: file.content.byteLength,
          executable: file.executable,
        })),
      read: async (path: string) => {
        const file = this.files.get(path);
        if (!file) throw new Error(`missing fake file: ${path}`);
        return Buffer.from(file.content);
      },
    };
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SandboxCommandResult> {
    this.commands.push(command);
    this.executeCalls.push({ command, cwd, env, timeoutMs });
    if (typeof env.HARNESS_HTTP_REQUEST === "string") {
      const request = JSON.parse(env.HARNESS_HTTP_REQUEST) as { url: string };
      return {
        exitCode: 0,
        stdout: HTTP_EVIDENCE_MARKER + JSON.stringify({
          status: 200,
          headers: {},
          body: request.url,
        }),
        stderr: "",
      };
    }
    const exitCode = this.exitCodes[command] ?? 0;
    const output = this.outputs[command] ?? (exitCode === 0 ? "ok" : `${command}: not found`);
    return {
      exitCode,
      stdout: exitCode === 0 ? output : "",
      stderr: exitCode === 0 ? "" : output,
    };
  }

  async runPty(): Promise<SandboxCommandResult> {
    throw new Error("preflight must not use PTY");
  }

  async readFile(path: string): Promise<Buffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`missing fake file: ${path}`);
    return Buffer.from(file.content);
  }

  async setNetworkBlocked(blocked: boolean): Promise<void> {
    this.networkBlocks.push(blocked);
  }

  async delete(): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted++;
  }
}

class RecordingProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  readonly handles: RecordingGateHandle[] = [];

  constructor(
    private readonly exitCodes: Record<string, number> = {},
    private readonly outputs: Record<string, string> = {},
    private readonly createError?: Error,
    private readonly deleteError?: Error,
  ) {}

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    this.requests.push(request);
    if (this.createError) throw this.createError;
    const handle = new RecordingGateHandle(
      `${request.role}-${this.handles.length + 1}`,
      this.exitCodes,
      this.outputs,
      this.deleteError,
    );
    this.handles.push(handle);
    return handle;
  }
}

const trustedContract: Contract = {
  id: "test.unit",
  type: "command",
  cmd: "node",
  args: ["test.js"],
};

function preflightOptions(
  root: string,
  provider: RecordingProvider,
  contracts: Contract[],
  gateSetup: string[] = [],
  gate = new GateCore().use(commandPlugin),
) {
  return {
    provider,
    root,
    policy: policy(gateSetup),
    contracts,
    gate,
    ctx: { cwd: root },
    environment: { HARNESS_DAYTONA_GATE_SNAPSHOT: "gate-test-snapshot" },
  };
}

test("static lint error returns not_ready and does not create sandbox", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract], ["nvm use 20"]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.selectedContracts, ["test.unit"]);
  assert.deepEqual(report.remoteContracts, ["test.unit"]);
  assert.deepEqual(report.hostLocalContracts, []);
  assert.equal(report.readinessErrors[0]?.id, "gateSetup.1.nvm");
  assert.deepEqual(provider.requests, []);
});

test("creates Gate sandbox, uploads baseline, runs setup and remote command, then cleans up", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/test.yaml": "trusted\n",
  });
  const provider = new RecordingProvider();

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract], ["npm ci"]),
  );

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.selectedContracts, ["test.unit"]);
  assert.deepEqual(report.remoteContracts, ["test.unit"]);
  assert.deepEqual(report.hostLocalContracts, []);
  assert.deepEqual(report.readinessErrors, []);
  assert.deepEqual(report.productFailures, []);
  assert.deepEqual(report.sandbox, {
    id: "gate-1",
    snapshot: "gate-test-snapshot",
    retained: false,
  });
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(provider.requests[0], {
    role: "gate",
    snapshot: "gate-test-snapshot",
    envVars: {},
    ephemeral: true,
  });
  const gate = provider.handles[0]!;
  assert.ok(gate.files.has("src/a.ts"));
  assert.ok(gate.files.has("contracts/test.yaml"));
  assert.deepEqual(gate.uploads[0], {
    files: ["contracts/test.yaml", "src/a.ts"],
    remoteRoot: REMOTE_ROOT,
  });
  assert.deepEqual(gate.verifies, [
    { files: ["contracts/test.yaml"], remoteRoot: REMOTE_ROOT },
    { files: ["contracts/test.yaml"], remoteRoot: REMOTE_ROOT },
  ]);
  assert.deepEqual(gate.commands, ["npm ci", COMMAND_TEST]);
  assert.deepEqual(gate.executeCalls.map(({ cwd }) => cwd), [REMOTE_ROOT, REMOTE_ROOT]);
  assert.equal(gate.executeCalls[0]?.timeoutMs, SETUP_TIMEOUT_MS);
  assert.deepEqual(gate.networkBlocks, [true]);
  assert.equal(gate.deleted, 1);
});

test("setup failure records setup step and error, skips contracts, then cleans up", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider({ "npm ci": 127 });

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract], ["npm ci"]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.setup.length, 1);
  assert.equal(report.setup[0]?.command, "npm ci");
  assert.equal(report.setup[0]?.exitCode, 127);
  assert.equal(report.readinessErrors[0]?.id, "gateSetup.1.failed");
  assert.match(report.readinessErrors[0]?.message ?? "", /gate setup command 1 failed/i);
  const gate = provider.handles[0]!;
  assert.deepEqual(gate.commands, ["npm ci"]);
  assert.deepEqual(gate.networkBlocks, []);
  assert.equal(gate.deleted, 1);
});

test("product contract failure is productFailures with no readinessErrors", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider(
    { [COMMAND_TEST]: 1 },
    { [COMMAND_TEST]: "assertion failed" },
  );

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.readinessErrors, []);
  assert.deepEqual(report.productFailures, ["test.unit"]);
  assert.equal(provider.handles[0]?.deleted, 1);
});

test("runtime infrastructure error from contract is readinessErrors", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider(
    { [COMMAND_TEST]: 1 },
    { [COMMAND_TEST]: "node: command not found" },
  );

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors[0]?.id, "contract.test.unit.runtime");
  assert.deepEqual(report.productFailures, []);
  assert.equal(provider.handles[0]?.deleted, 1);
});

test("host-local-only contracts return ready and do not create sandbox", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const miniprogram: Contract = {
    id: "mp.smoke",
    type: "miniprogram",
    projectPath: "dist/dev/mp-weixin",
    runner: "test/gates/runner.js",
  };

  const report = await runGatePreflight(
    preflightOptions(root, provider, [miniprogram]),
  );

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.selectedContracts, ["mp.smoke"]);
  assert.deepEqual(report.remoteContracts, []);
  assert.deepEqual(report.hostLocalContracts, ["mp.smoke"]);
  assert.deepEqual(provider.requests, []);
});

test("loopback HTTP remote contract does not block Gate network", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const loopback: Contract = {
    id: "http.loopback",
    type: "http",
    trigger: { url: "http://127.0.0.1:4173/health" },
    expect: { status: 200 },
  };

  const report = await runGatePreflight(
    preflightOptions(root, provider, [loopback], ["node server.js"], new GateCore().use(httpPlugin)),
  );

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.remoteContracts, ["http.loopback"]);
  assert.deepEqual(provider.handles[0]?.networkBlocks, []);
});

test("IPv6 loopback HTTP remote contract does not block Gate network", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const loopback: Contract = {
    id: "http.loopback.ipv6",
    type: "http",
    trigger: { url: "http://[::1]:4173/health" },
    expect: { status: 200 },
  };

  const report = await runGatePreflight(
    preflightOptions(root, provider, [loopback], ["node server.js"], new GateCore().use(httpPlugin)),
  );

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.remoteContracts, ["http.loopback.ipv6"]);
  assert.deepEqual(provider.handles[0]?.networkBlocks, []);
});

test("ctx baseUrl loopback HTTP remote contract does not block Gate network", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider();
  const loopback: Contract = {
    id: "http.loopback.ctx",
    type: "http",
    trigger: { path: "/health" },
    expect: { status: 200 },
  };

  const report = await runGatePreflight({
    ...preflightOptions(root, provider, [loopback], ["node server.js"], new GateCore().use(httpPlugin)),
    ctx: { cwd: root, baseUrl: "http://127.0.0.1:4173" } as RunContext & { baseUrl: string },
  });

  assert.equal(report.outcome, "ready");
  assert.deepEqual(report.remoteContracts, ["http.loopback.ctx"]);
  assert.deepEqual(provider.handles[0]?.networkBlocks, []);
});

test("protected file verification failure is a readiness error", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/test.yaml": "trusted\n",
  });
  class VerifyFailHandle extends RecordingGateHandle {
    override async verify(
      files: WorkspaceFile[],
      remoteRoot: string,
    ): Promise<void> {
      await super.verify(files, remoteRoot);
      throw new Error("protected drift");
    }
  }
  class VerifyFailProvider extends RecordingProvider {
    override async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
      this.requests.push(request);
      const handle = new VerifyFailHandle(
        `${request.role}-${this.handles.length + 1}`,
        {},
      );
      this.handles.push(handle);
      return handle;
    }
  }
  const provider = new VerifyFailProvider();

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors[0]?.id, "gate.sandbox.error");
  assert.match(report.readinessErrors[0]?.message ?? "", /protected drift/);
  assert.equal(provider.handles[0]?.deleted, 1);
});

test("retainOnFailure keeps sandbox and marks retained", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider(
    { [COMMAND_TEST]: 1 },
    { [COMMAND_TEST]: "assertion failed" },
  );

  const report = await runGatePreflight({
    ...preflightOptions(root, provider, [trustedContract]),
    retainOnFailure: true,
  });

  assert.equal(report.outcome, "not_ready");
  assert.deepEqual(report.productFailures, ["test.unit"]);
  assert.deepEqual(report.sandbox, {
    id: "gate-1",
    snapshot: "gate-test-snapshot",
    retained: true,
  });
  assert.equal(provider.handles[0]?.deleted, 0);
});

test("provider sandbox exception records sandbox readiness error", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider({}, {}, new Error("create failed"));

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors[0]?.id, "gate.sandbox.error");
  assert.match(report.readinessErrors[0]?.message ?? "", /create failed/);
});

test("cleanup delete failure records cleanup readiness error", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = new RecordingProvider({}, {}, undefined, new Error("delete failed"));

  const report = await runGatePreflight(
    preflightOptions(root, provider, [trustedContract]),
  );

  assert.equal(report.outcome, "not_ready");
  assert.equal(report.readinessErrors[0]?.id, "gate.cleanup.failed");
  assert.match(report.readinessErrors[0]?.message ?? "", /delete failed/);
  assert.deepEqual(report.sandbox, {
    id: "gate-1",
    snapshot: "gate-test-snapshot",
    retained: true,
  });
});

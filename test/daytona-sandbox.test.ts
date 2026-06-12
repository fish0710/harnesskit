import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo } from "@daytona/sdk";

import {
  createDaytonaManager,
  createDaytonaSdkProviderFromClient,
} from "../src/harness/sandbox/daytona.js";

interface CreateRequest {
  role: "agent" | "gate";
  envVars: Record<string, string>;
  ephemeral: boolean;
}

interface CreatedSdkRequest {
  language?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  ephemeral?: boolean;
}

const modelEnvironment = {
  ANTHROPIC_AUTH_TOKEN: "agent-token",
  ANTHROPIC_BASE_URL: "https://model.example.test",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
  ANTHROPIC_MODEL: "sonnet",
  ANTHROPIC_REASONING_MODEL: "reasoning",
};

function completeEnvironment(): Record<string, string> {
  return {
    DAYTONA_API_KEY: "daytona-control-plane-key",
    ANTHROPIC_API_KEY: "must-not-be-forwarded",
    HARNESS_GATE_SIGNING_KEY: "must-not-be-forwarded",
    ...modelEnvironment,
  };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

test("manager keeps model credentials out of both sandbox-level environments", async () => {
  const created: CreateRequest[] = [];
  const provider = {
    async create(request: CreateRequest) {
      created.push(request);
      return recordingHandle(`sandbox-${created.length}`);
    },
  };
  const manager = createDaytonaManager({
    provider,
    environment: completeEnvironment(),
  });

  await manager.createAgentSandbox();
  await manager.createGateSandbox();

  assert.equal(created[0]?.role, "agent");
  assert.deepEqual(created[0]?.envVars, {});
  assert.equal(created[1]?.role, "gate");
  assert.deepEqual(created[1]?.envVars, {});
  assert.equal("DAYTONA_API_KEY" in created[0]!.envVars, false);
  assert.equal("ANTHROPIC_API_KEY" in created[0]!.envVars, false);
  assert.equal("HARNESS_GATE_SIGNING_KEY" in created[0]!.envVars, false);
});

test("manager rejects a missing Daytona API key before provider creation", () => {
  let createCalls = 0;
  const provider = {
    async create(_request: CreateRequest) {
      createCalls++;
      return recordingHandle("unexpected");
    },
  };

  assert.throws(
    () => createDaytonaManager({ provider, environment: {} }),
    /DAYTONA_API_KEY/,
  );
  assert.equal(createCalls, 0);
});

test("SDK provider maps role, environment, and lifecycle fields into create", async () => {
  const created: CreatedSdkRequest[] = [];
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient({
    async create(request: CreatedSdkRequest) {
      created.push(request);
      return sdkSandbox;
    },
    async delete() {
      sdkSandbox.calls.deleted++;
    },
  });

  await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });
  await provider.create({
    role: "gate",
    envVars: {},
    ephemeral: true,
  });

  assert.deepEqual(created, [
    {
      language: "typescript",
      labels: { "harness.role": "agent" },
      envVars: modelEnvironment,
      ephemeral: false,
      networkBlockAll: false,
    },
    {
      language: "typescript",
      labels: { "harness.role": "gate" },
      envVars: {},
      ephemeral: true,
      networkBlockAll: false,
    },
  ]);
  assert.equal(
    Object.values(created[1]?.envVars ?? {}).includes("agent-token"),
    false,
  );
});

test("SDK handle uploads nested files and preserves executable mode", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });
  const content = Buffer.from("#!/bin/sh\necho ok\n");

  await handle.upload([
    {
      path: "scripts/check.sh",
      content,
      executable: true,
      sha256: sha256(content),
    },
  ], "/workspace/candidate");

  assert.deepEqual(sdkSandbox.calls.createdFolders, [
    ["/workspace/candidate", "755"],
    ["/workspace/candidate/scripts", "755"],
  ]);
  assert.equal(sdkSandbox.calls.uploads.length, 1);
  assert.equal(
    sdkSandbox.calls.uploads[0]?.destination,
    "/workspace/candidate/scripts/check.sh",
  );
  assert.deepEqual(sdkSandbox.calls.uploads[0]?.source, content);
  assert.deepEqual(sdkSandbox.calls.permissions, [
    ["/workspace/candidate/scripts/check.sh", { mode: "755" }],
  ]);
});

test("SDK handle rejects upload paths outside the remote workspace", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: {},
    ephemeral: false,
  });
  const content = Buffer.from("escape");

  await assert.rejects(
    () => handle.upload([{
      path: "../../etc/passwd",
      content,
      executable: false,
      sha256: sha256(content),
    }], "/workspace/candidate"),
    /父级|路径|parent|escape|ambiguous/i,
  );
  assert.deepEqual(sdkSandbox.calls.uploads, []);
});

test("remote workspace recursively lists entries and maps unknown modes to special", async () => {
  const sdkSandbox = fakeSdkSandbox({
    listings: new Map<string, FileInfo[]>([
      ["/workspace/candidate", [
        fileInfo("src", true, "drwxr-xr-x"),
        fileInfo("README.md", false, "-rw-r--r--", 6),
        fileInfo("link", false, "Lrwxrwxrwx"),
        fileInfo("device", false, "mystery"),
      ]],
      ["/workspace/candidate/src", [
        fileInfo("index.ts", false, "-rwxr-xr-x", 13),
      ]],
    ]),
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  const entries = await handle.workspace("/workspace/candidate")
    .list("/workspace/candidate");

  assert.deepEqual(entries, [
    { path: "src", kind: "directory", size: 0, executable: false },
    { path: "src/index.ts", kind: "file", size: 13, executable: true },
    { path: "README.md", kind: "file", size: 6, executable: false },
    { path: "link", kind: "symlink", size: 0, executable: false },
    { path: "device", kind: "special", size: 0, executable: false },
  ]);
  assert.deepEqual(sdkSandbox.calls.listed, [
    "/workspace/candidate",
    "/workspace/candidate/src",
  ]);
});

test("remote workspace downloads regular file bytes through the SDK", async () => {
  const sdkSandbox = fakeSdkSandbox({
    listings: new Map([
      ["/workspace/candidate", [
        fileInfo("src", true, "drwxr-xr-x"),
      ]],
      ["/workspace/candidate/src", [
        fileInfo("index.ts", false, "-rw-r--r--", 11),
      ]],
    ]),
    downloads: new Map([
      ["/workspace/candidate/src/index.ts", Buffer.from("export {};\n")],
    ]),
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  const workspace = handle.workspace("/workspace/candidate");
  await workspace.list("/workspace/candidate");
  const bytes = await workspace.read("src/index.ts");

  assert.deepEqual(bytes, Buffer.from("export {};\n"));
  assert.deepEqual(sdkSandbox.calls.downloaded, [
    "/workspace/candidate/src/index.ts",
  ]);
});

test("SDK handle runs commands in a PTY, captures output, and disconnects", async () => {
  const sdkSandbox = fakeSdkSandbox({
    ptyOutput: ["first line\n", "second line\n"],
    ptyExitCode: 7,
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  const result = await handle.runPty(
    '"$HOME/.local/bin/claude" --verbose',
    "/workspace/candidate",
    { HARNESS_PROMPT: "fix the test", ...modelEnvironment },
  );

  assert.deepEqual(sdkSandbox.calls.ptyOptions, {
    id: sdkSandbox.calls.ptyOptions?.id,
    cwd: "/workspace/candidate",
    envs: { HARNESS_PROMPT: "fix the test", ...modelEnvironment },
    onData: sdkSandbox.calls.ptyOptions?.onData,
  });
  assert.match(sdkSandbox.calls.ptyOptions?.id ?? "", /^harness-/);
  assert.equal(typeof sdkSandbox.calls.ptyOptions?.onData, "function");
  assert.deepEqual(sdkSandbox.calls.ptyInputs, [
    'exec "$HOME/.local/bin/claude" --verbose\n',
  ]);
  assert.equal(sdkSandbox.calls.ptyWaitForConnection, 1);
  assert.equal(sdkSandbox.calls.ptyWait, 1);
  assert.equal(sdkSandbox.calls.ptyDisconnect, 1);
  assert.deepEqual(result, {
    exitCode: 7,
    stdout: "first line\nsecond line\n",
    stderr: "",
  });
});

test("SDK handle toggles sandbox network blocking", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "gate",
    envVars: {},
    ephemeral: true,
  });

  await handle.setNetworkBlocked(true);
  await handle.setNetworkBlocked(false);

  assert.deepEqual(sdkSandbox.calls.networkBlocked, [true, false]);
});

test("SDK handle deletes the underlying sandbox", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "gate",
    envVars: {},
    ephemeral: true,
  });

  await handle.delete();

  assert.equal(sdkSandbox.calls.deleted, 1);
});

function fileInfo(
  name: string,
  isDir: boolean,
  mode: string,
  size = 0,
): FileInfo {
  return {
    name,
    isDir,
    mode,
    size,
    group: "daytona",
    modTime: "",
    modifiedAt: "",
    owner: "daytona",
    permissions: mode,
  };
}

function recordingHandle(id: string) {
  return {
    id,
    async upload() {},
    workspace() {
      return {
        async list() { return []; },
        async read() { return Buffer.alloc(0); },
      };
    },
    async execute() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async runPty() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async setNetworkBlocked() {},
    async delete() {},
  };
}

function fakeSdkClient(sandbox: ReturnType<typeof fakeSdkSandbox>) {
  return {
    async create() {
      return sandbox;
    },
    async delete() {
      sandbox.calls.deleted++;
    },
  };
}

function fakeSdkSandbox(options: {
  listings?: Map<string, FileInfo[]>;
  downloads?: Map<string, Buffer>;
  ptyOutput?: string[];
  ptyExitCode?: number;
} = {}) {
  const calls = {
    createdFolders: [] as Array<[string, string]>,
    uploads: [] as Array<{ source: Buffer; destination: string }>,
    permissions: [] as Array<[string, { mode: string }]>,
    listed: [] as string[],
    downloaded: [] as string[],
    ptyOptions: undefined as {
      id: string;
      cwd?: string;
      envs?: Record<string, string>;
      onData: (data: Uint8Array) => void | Promise<void>;
    } | undefined,
    ptyInputs: [] as string[],
    ptyWaitForConnection: 0,
    ptyWait: 0,
    ptyDisconnect: 0,
    deleted: 0,
    networkBlocked: [] as boolean[],
  };

  return {
    id: "sdk-sandbox",
    calls,
    fs: {
      async createFolder(path: string, mode: string) {
        calls.createdFolders.push([path, mode]);
      },
      async uploadFiles(
        files: Array<{ source: Buffer; destination: string }>,
      ) {
        calls.uploads.push(...files);
      },
      async setFilePermissions(
        path: string,
        permissions: { mode: string },
      ) {
        calls.permissions.push([path, permissions]);
      },
      async listFiles(path: string) {
        calls.listed.push(path);
        return options.listings?.get(path) ?? [];
      },
      async downloadFile(path: string) {
        calls.downloaded.push(path);
        const content = options.downloads?.get(path);
        if (!content) throw new Error(`Missing fake download: ${path}`);
        return content;
      },
      async getFileDetails(path: string) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        const name = path.slice(path.lastIndexOf("/") + 1);
        const info = options.listings
          ?.get(parent)
          ?.find((entry) => entry.name === name);
        if (info) return info;
        const content = options.downloads?.get(path);
        if (!content) throw new Error(`Missing fake details: ${path}`);
        return fileInfo(name, false, "-rw-r--r--", content.byteLength);
      },
    },
    process: {
      async executeCommand() {
        return { exitCode: 0, result: "" };
      },
      async createPty(ptyOptions: {
        id: string;
        cwd?: string;
        envs?: Record<string, string>;
        onData: (data: Uint8Array) => void | Promise<void>;
      }) {
        calls.ptyOptions = ptyOptions;
        return {
          async waitForConnection() {
            calls.ptyWaitForConnection++;
          },
          async sendInput(input: string) {
            calls.ptyInputs.push(input);
            for (const chunk of options.ptyOutput ?? []) {
              await ptyOptions.onData(Buffer.from(chunk));
            }
          },
          async wait() {
            calls.ptyWait++;
            return { exitCode: options.ptyExitCode ?? 0 };
          },
          async kill() {},
          async disconnect() {
            calls.ptyDisconnect++;
          },
        };
      },
    },
    async updateNetworkSettings(
      settings: { networkBlockAll: boolean },
    ) {
      calls.networkBlocked.push(settings.networkBlockAll);
    },
  };
}

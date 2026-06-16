import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo } from "@daytona/sdk";

import {
  createDaytonaExecutionTarget,
  createDaytonaManager,
  createDaytonaSdkProviderFromClient,
  rewriteRemoteToolboxProxy,
} from "../src/harness/sandbox/daytona.js";
import type { SandboxCreateRequest } from "../src/harness/sandbox/types.js";

interface CreateRequest {
  role: "agent" | "gate";
  snapshot?: string;
  envVars: Record<string, string>;
  ephemeral: boolean;
  volumes?: Array<{ volumeName: string; mountPath: string; subpath?: string }>;
}

interface CreatedSdkRequest {
  language?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  ephemeral?: boolean;
  networkBlockAll?: boolean;
  volumes?: Array<{ volumeId: string; mountPath: string; subpath?: string }>;
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

const gateSnapshotTypeCheck: SandboxCreateRequest = {
  role: "gate",
  snapshot: "harness-gate-runtime-latest",
  envVars: {},
  ephemeral: true,
};
void gateSnapshotTypeCheck;

function completeEnvironment(): Record<string, string> {
  return {
    DAYTONA_API_KEY: "daytona-control-plane-key",
    HARNESS_DAYTONA_AGENT_SNAPSHOT: "harness-agent-claude-2.1.145-r1",
    HARNESS_DAYTONA_GATE_SNAPSHOT: "harness-gate-runtime-latest",
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

test("manager passes configured Agent and Gate snapshots to their sandbox creation", async () => {
  const created: CreateRequest[] = [];
  const provider = {
    async create(request: CreateRequest) {
      created.push(request);
      return recordingHandle(`sandbox-${created.length}`);
    },
  };
  const manager = createDaytonaManager({
    provider,
    environment: {
      ...completeEnvironment(),
      HARNESS_DAYTONA_AGENT_SNAPSHOT: "  harness-agent-claude-2.1.145-r1  ",
      HARNESS_DAYTONA_GATE_SNAPSHOT: "  harness-gate-runtime-latest  ",
    },
  });

  await manager.createAgentSandbox();
  await manager.createGateSandbox();

  assert.equal(created[0]?.role, "agent");
  assert.equal(created[0]?.snapshot, "harness-agent-claude-2.1.145-r1");
  assert.equal(created[1]?.role, "gate");
  assert.equal(created[1]?.snapshot, "harness-gate-runtime-latest");
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

test("manager rejects blank Agent or Gate snapshot before provider creation", () => {
  for (const [key, value] of [
    ["HARNESS_DAYTONA_AGENT_SNAPSHOT", ""],
    ["HARNESS_DAYTONA_AGENT_SNAPSHOT", "   "],
    ["HARNESS_DAYTONA_GATE_SNAPSHOT", ""],
    ["HARNESS_DAYTONA_GATE_SNAPSHOT", "   "],
  ] as const) {
    let createCalls = 0;
    const provider = {
      async create(_request: CreateRequest) {
        createCalls++;
        return recordingHandle("unexpected");
      },
    };
    const environment = completeEnvironment();
    environment[key] = value;

    assert.throws(
      () => createDaytonaManager({ provider, environment }),
      new RegExp(key),
    );
    assert.equal(createCalls, 0);
  }
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
    snapshot: "  harness-agent-claude-2.1.145-r1  ",
    envVars: modelEnvironment,
    ephemeral: false,
  });
  await provider.create({
    role: "gate",
    snapshot: "  harness-gate-runtime-latest  ",
    envVars: {},
    ephemeral: true,
  });

  assert.deepEqual(created, [
    {
      language: "typescript",
      snapshot: "harness-agent-claude-2.1.145-r1",
      labels: { "harness.role": "agent" },
      envVars: modelEnvironment,
      ephemeral: false,
      networkBlockAll: false,
    },
    {
      language: "typescript",
      snapshot: "harness-gate-runtime-latest",
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

test("SDK provider resolves requested volumes before sandbox creation", async () => {
  const created: CreatedSdkRequest[] = [];
  const volumeGets: Array<{ name: string; create: boolean | undefined }> = [];
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient({
    volume: {
      async get(name: string, create?: boolean) {
        volumeGets.push({ name, create });
        return { id: "volume-123", name, __brand: "Volume" as const };
      },
    },
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
    snapshot: "harness-agent-claude-latest",
    envVars: {},
    ephemeral: false,
    volumes: [{
      volumeName: "harness-claude-observability",
      mountPath: "/harness-observability",
      subpath: "runs/run-123",
    }],
  });

  assert.deepEqual(volumeGets, [{
    name: "harness-claude-observability",
    create: true,
  }]);
  assert.deepEqual(created[0]?.volumes, [{
    volumeId: "volume-123",
    mountPath: "/harness-observability",
    subpath: "runs/run-123",
  }]);
});

test("SDK provider fails closed when volume service is missing for a volume request", async () => {
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

  await assert.rejects(
    () =>
      provider.create({
        role: "agent",
        envVars: {},
        ephemeral: false,
        volumes: [{
          volumeName: "harness-claude-observability",
          mountPath: "/harness-observability",
        }],
      }),
    /Daytona volume service is required/,
  );
  assert.deepEqual(created, []);
});

test("SDK provider rejects blank volume names before volume resolution", async () => {
  const created: CreatedSdkRequest[] = [];
  const volumeGets: string[] = [];
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient({
    volume: {
      async get(name: string) {
        volumeGets.push(name);
        return { id: "volume-123", name };
      },
    },
    async create(request: CreatedSdkRequest) {
      created.push(request);
      return sdkSandbox;
    },
    async delete() {
      sdkSandbox.calls.deleted++;
    },
  });

  await assert.rejects(
    () =>
      provider.create({
        role: "agent",
        envVars: {},
        ephemeral: false,
        volumes: [{
          volumeName: "   ",
          mountPath: "/harness-observability",
        }],
      }),
    /volumeName/i,
  );
  assert.deepEqual(created, []);
  assert.deepEqual(volumeGets, []);
});

test("SDK provider rejects unsafe volume mount paths before sandbox creation", async () => {
  for (const mountPath of ["", "relative/path", "/", "/tmp/\0bad", "/workspace", "/workspace/candidate"]) {
    const created: CreatedSdkRequest[] = [];
    const volumeGets: string[] = [];
    const sdkSandbox = fakeSdkSandbox();
    const provider = createDaytonaSdkProviderFromClient({
      volume: {
        async get(name: string) {
          volumeGets.push(name);
          return { id: "volume-123", name };
        },
      },
      async create(request: CreatedSdkRequest) {
        created.push(request);
        return sdkSandbox;
      },
      async delete() {
        sdkSandbox.calls.deleted++;
      },
    });

    await assert.rejects(
      () =>
        provider.create({
          role: "agent",
          envVars: {},
          ephemeral: false,
          volumes: [{
            volumeName: "harness-claude-observability",
            mountPath,
          }],
        }),
      /volume mountPath/i,
    );
    assert.deepEqual(created, []);
    assert.deepEqual(volumeGets, []);
  }
});

test("SDK provider rejects unsafe volume subpaths before sandbox creation", async () => {
  for (const subpath of ["", "/absolute", "../escape", "nested/../escape", "bad\0path", "bad\\path"]) {
    const created: CreatedSdkRequest[] = [];
    const volumeGets: string[] = [];
    const sdkSandbox = fakeSdkSandbox();
    const provider = createDaytonaSdkProviderFromClient({
      volume: {
        async get(name: string) {
          volumeGets.push(name);
          return { id: "volume-123", name };
        },
      },
      async create(request: CreatedSdkRequest) {
        created.push(request);
        return sdkSandbox;
      },
      async delete() {
        sdkSandbox.calls.deleted++;
      },
    });

    await assert.rejects(
      () =>
        provider.create({
          role: "agent",
          envVars: {},
          ephemeral: false,
          volumes: [{
            volumeName: "harness-claude-observability",
            mountPath: "/harness-observability",
            subpath,
          }],
        }),
      /volume subpath/i,
    );
    assert.deepEqual(created, []);
    assert.deepEqual(volumeGets, []);
  }
});

test("SDK provider keeps PTY toolbox URLs on the public toolbox proxy", async () => {
  const sdkSandbox = fakeSdkSandbox({
    toolboxProxyUrl: "http://proxy.localhost:4000/toolbox",
  });
  const provider = createDaytonaSdkProviderFromClient(
    fakeSdkClient(sdkSandbox),
    "https://daytona.example.test:8443/api",
  );

  await provider.create({
    role: "agent",
    snapshot: "harness-agent-claude-2.1.145-r1",
    envVars: {},
    ephemeral: false,
  });

  assert.equal(
    sdkSandbox.toolboxProxyUrl,
    "https://daytona.example.test:8443/toolbox",
  );
  assert.equal(
    sdkSandbox.axiosInstance.defaults.baseURL,
    "https://daytona.example.test:8443/api/toolbox/sdk-sandbox/toolbox",
  );
  assert.equal(
    sdkSandbox.clientConfig.basePath,
    "https://daytona.example.test:8443/api/toolbox/sdk-sandbox/toolbox",
  );
});

test("toolbox rewrite leaves local Daytona APIs untouched", () => {
  const sdkSandbox = fakeSdkSandbox({
    toolboxProxyUrl: "http://proxy.localhost:4000/toolbox",
  });

  rewriteRemoteToolboxProxy(sdkSandbox, "http://localhost:3000/api");

  assert.equal(sdkSandbox.toolboxProxyUrl, "http://proxy.localhost:4000/toolbox");
  assert.equal(sdkSandbox.axiosInstance.defaults.baseURL, undefined);
  assert.equal(sdkSandbox.clientConfig.basePath, undefined);
});

test("SDK provider rejects empty Agent snapshot requests before client create", async () => {
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

  await assert.rejects(
    () =>
      provider.create({
        role: "agent",
        snapshot: "   ",
        envVars: {},
        ephemeral: false,
      }),
    /Agent snapshot must not be empty/,
  );
  assert.deepEqual(created, []);
});

test("SDK provider rejects empty Gate snapshot requests before client create", async () => {
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

  await assert.rejects(
    () =>
      provider.create({
        role: "gate",
        snapshot: "   ",
        envVars: {},
        ephemeral: true,
      }),
    /Gate snapshot must not be empty/,
  );
  assert.deepEqual(created, []);
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
    ["workspace/candidate", "755"],
    ["workspace/candidate/scripts", "755"],
  ]);
  assert.equal(sdkSandbox.calls.uploads.length, 1);
  assert.equal(
    sdkSandbox.calls.uploads[0]?.destination,
    "workspace/candidate/scripts/check.sh",
  );
  assert.deepEqual(sdkSandbox.calls.uploads[0]?.source, content);
  assert.deepEqual(sdkSandbox.calls.permissions, [
    ["workspace/candidate/scripts/check.sh", { mode: "755" }],
  ]);
});

test("SDK handle creates an empty workspace without an empty multipart upload", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: {},
    ephemeral: false,
  });

  await handle.upload([], "/workspace/candidate");

  assert.deepEqual(sdkSandbox.calls.createdFolders, [
    ["workspace/candidate", "755"],
  ]);
  assert.deepEqual(sdkSandbox.calls.uploads, []);
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
    "workspace/candidate",
    "workspace/candidate/src",
  ]);
});

test("remote workspace only descends into watched candidate and protected roots", async () => {
  const sdkSandbox = fakeSdkSandbox({
    listings: new Map<string, FileInfo[]>([
      ["/workspace/candidate", [
        fileInfo("src", true, "drwxr-xr-x"),
        fileInfo("contracts", true, "drwxr-xr-x"),
        fileInfo("node_modules", true, "drwxr-xr-x"),
      ]],
      ["/workspace/candidate/src", [
        fileInfo("index.ts", false, "-rw-r--r--", 3),
      ]],
      ["/workspace/candidate/contracts", [
        fileInfo("gate.yaml", false, "-rw-r--r--", 3),
      ]],
      ["/workspace/candidate/node_modules", [
        fileInfo("pkg", true, "drwxr-xr-x"),
      ]],
    ]),
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  const entries = await handle.workspace(
    "/workspace/candidate",
    100,
    ["src", "contracts"],
  ).list("/workspace/candidate");

  assert.deepEqual(entries.map((entry) => entry.path), [
    "src",
    "src/index.ts",
    "contracts",
    "contracts/gate.yaml",
    "node_modules",
  ]);
  assert.deepEqual(sdkSandbox.calls.listed, [
    "workspace/candidate",
    "workspace/candidate/src",
    "workspace/candidate/contracts",
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
    "workspace/candidate/src/index.ts",
  ]);
});

test("SDK handle verifies host-controlled bytes and metadata", async () => {
  const content = Buffer.from("trusted\n");
  const sdkSandbox = fakeSdkSandbox({
    listings: new Map([
      ["/workspace/candidate/contracts", [
        fileInfo("gate.yaml", false, "-rw-r--r--", content.byteLength),
      ]],
    ]),
    downloads: new Map([
      ["/workspace/candidate/contracts/gate.yaml", content],
    ]),
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "gate",
    envVars: {},
    ephemeral: true,
  });
  const expected = {
    path: "contracts/gate.yaml",
    content,
    executable: false,
    sha256: sha256(content),
  };

  await handle.verify([expected], "/workspace/candidate");
  sdkSandbox.calls.downloaded.length = 0;
  sdkSandbox.options.downloads?.set(
    "/workspace/candidate/contracts/gate.yaml",
    Buffer.from("tampered"),
  );

  await assert.rejects(
    () => handle.verify([expected], "/workspace/candidate"),
    /bytes changed/,
  );
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
    '"/usr/local/bin/claude" --verbose',
    "/workspace/candidate",
    { HARNESS_PROMPT: "fix the test", ...modelEnvironment },
  );

  assert.deepEqual(sdkSandbox.calls.ptyOptions, {
    id: sdkSandbox.calls.ptyOptions?.id,
    cwd: "workspace/candidate",
    envs: { HARNESS_PROMPT: "fix the test", ...modelEnvironment },
    onData: sdkSandbox.calls.ptyOptions?.onData,
  });
  assert.match(sdkSandbox.calls.ptyOptions?.id ?? "", /^harness-/);
  assert.equal(typeof sdkSandbox.calls.ptyOptions?.onData, "function");
  assert.deepEqual(sdkSandbox.calls.ptyInputs, [
    '{ "/usr/local/bin/claude" --verbose; }; status=$?; exit "$status"\n',
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

test("SDK handle wraps exec-prefixed PTY commands without nesting exec", async () => {
  const sdkSandbox = fakeSdkSandbox();
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  await handle.runPty(
    "exec npm test",
    "/workspace/candidate",
    {},
  );

  assert.deepEqual(sdkSandbox.calls.ptyInputs, [
    '{ exec npm test; }; status=$?; exit "$status"\n',
  ]);
});

test("SDK handle includes recent PTY output when a PTY times out", async () => {
  const sdkSandbox = fakeSdkSandbox({
    ptyOutput: [
      "installing dependencies\n",
      "bash: exec: npm: not found\n",
    ],
    ptyWaitNever: true,
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  await assert.rejects(
    Promise.race([
      handle.runPty(
        "sleep infinity",
        "/workspace/candidate",
        {},
        10,
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("test guard timed out")), 250)
      ),
    ]),
    /PTY timed out after 10ms[\s\S]*bash: exec: npm: not found/,
  );
  assert.equal(sdkSandbox.calls.ptyKill, 1);
  assert.equal(sdkSandbox.calls.ptyDisconnect, 1);
});

test("SDK handle preserves timeout diagnostics when PTY cleanup fails", async () => {
  const sdkSandbox = fakeSdkSandbox({
    ptyOutput: ["last useful line\n"],
    ptyWaitNever: true,
    ptyKillError: new Error("kill failed"),
    ptyDisconnectError: new Error("disconnect failed"),
  });
  const provider = createDaytonaSdkProviderFromClient(fakeSdkClient(sdkSandbox));
  const handle = await provider.create({
    role: "agent",
    envVars: modelEnvironment,
    ephemeral: false,
  });

  await assert.rejects(
    Promise.race([
      handle.runPty(
        "sleep infinity",
        "/workspace/candidate",
        {},
        10,
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("test guard timed out")), 250)
      ),
    ]),
    /PTY timed out after 10ms[\s\S]*last useful line/,
  );
  assert.equal(sdkSandbox.calls.ptyKill, 1);
  assert.equal(sdkSandbox.calls.ptyDisconnect, 1);
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

test("remote execution target preserves trusted argv and host execution id", async () => {
  const commands: Array<{
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }> = [];
  const handle = {
    ...recordingHandle("execution"),
    async execute(
      command: string,
      cwd: string,
      env?: Record<string, string>,
      timeoutMs?: number,
    ) {
      commands.push({ command, cwd, env, timeoutMs });
      return { exitCode: 7, stdout: "out", stderr: "err" };
    },
  };
  const target = createDaytonaExecutionTarget(
    handle,
    "/workspace/candidate",
  );

  const evidence = await target.execute({
    executionId: "host-id",
    command: "node",
    args: ["test file.js", "a'b"],
    cwd: "/workspace/candidate",
    timeoutMs: 2500,
  });

  assert.equal(evidence.executionId, "host-id");
  assert.equal(evidence.exitCode, 7);
  assert.match(commands[0]?.command ?? "", /^'\/usr\/bin\/env' '--'/);
  assert.match(commands[0]?.command ?? "", /'test file\.js'/);
  assert.match(commands[0]?.command ?? "", /'a'\"'\"'b'/);
  assert.equal(commands[0]?.timeoutMs, 2500);
});

test("remote HTTP target converts malformed envelopes into error evidence", async () => {
  const handle = {
    ...recordingHandle("http"),
    async execute() {
      return { exitCode: 0, stdout: "not-json", stderr: "" };
    },
  };
  const target = createDaytonaExecutionTarget(
    handle,
    "/workspace/candidate",
  );

  const evidence = await target.request({
    executionId: "http-id",
    url: "http://127.0.0.1:3000/health",
    method: "GET",
  });

  assert.equal(evidence.executionId, "http-id");
  assert.ok(evidence.error);
  assert.equal(evidence.status, undefined);
});

test("remote HTTP target avoids inline node eval for the evidence script", async () => {
  const calls: Array<{ command: string; env: Record<string, string> }> = [];
  const handle = {
    ...recordingHandle("http"),
    async execute(command: string, _cwd: string, env: Record<string, string>) {
      calls.push({ command, env });
      if (command.includes(" '-e' ") || command.includes(" -e ")) {
        return {
          exitCode: 0,
          stdout: "/usr/bin/bash: polluted stdout",
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout:
          "HARNESS_HTTP_EVIDENCE " +
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: "{\"status\":\"ok\"}",
          }),
        stderr: "",
      };
    },
  };
  const target = createDaytonaExecutionTarget(
    handle,
    "/workspace/candidate",
  );

  const evidence = await target.request({
    executionId: "http-id",
    url: "http://127.0.0.1:3000/health",
    method: "GET",
  });

  assert.equal(evidence.executionId, "http-id");
  assert.equal(evidence.status, 200);
  assert.equal(evidence.error, undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /HARNESS_HTTP_SCRIPT_B64/);
  assert.equal(typeof calls[0]!.env.HARNESS_HTTP_SCRIPT_B64, "string");
  assert.equal(typeof calls[0]!.env.HARNESS_HTTP_REQUEST, "string");
});

test("remote HTTP target ignores shell stdout before the evidence marker", async () => {
  const handle = {
    ...recordingHandle("http"),
    async execute() {
      return {
        exitCode: 0,
        stdout:
          "/usr/bin/bash: warning: setlocale failed\n" +
          "HARNESS_HTTP_EVIDENCE " +
          JSON.stringify({
            status: 204,
            headers: { "x-gate": "ok" },
            body: "",
          }),
        stderr: "",
      };
    },
  };
  const target = createDaytonaExecutionTarget(
    handle,
    "/workspace/candidate",
  );

  const evidence = await target.request({
    executionId: "http-id",
    url: "http://127.0.0.1:3000/health",
    method: "GET",
  });

  assert.equal(evidence.executionId, "http-id");
  assert.equal(evidence.status, 204);
  assert.equal(evidence.headers["x-gate"], "ok");
  assert.equal(evidence.error, undefined);
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
    async remove() {},
    async verify() {},
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
  toolboxProxyUrl?: string;
  ptyOutput?: string[];
  ptyExitCode?: number;
  ptyWaitNever?: boolean;
  ptyKillError?: Error;
  ptyDisconnectError?: Error;
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
    ptyKill: 0,
    ptyDisconnect: 0,
    deleted: 0,
    networkBlocked: [] as boolean[],
  };

  return {
    id: "sdk-sandbox",
    toolboxProxyUrl: options.toolboxProxyUrl,
    axiosInstance: {
      defaults: {} as { baseURL?: string },
    },
    clientConfig: {} as { basePath?: string },
    calls,
    options,
    fs: {
      async createFolder(path: string, mode: string) {
        if (path.startsWith("/")) {
          throw new Error(`SDK path must be relative: ${path}`);
        }
        calls.createdFolders.push([path, mode]);
      },
      async deleteFile() {},
      async uploadFiles(
        files: Array<{ source: Buffer; destination: string }>,
      ) {
        if (files.length === 0) {
          throw new Error("empty multipart upload");
        }
        calls.uploads.push(...files);
      },
      async setFilePermissions(
        path: string,
        permissions: { mode: string },
      ) {
        calls.permissions.push([path, permissions]);
      },
      async listFiles(path: string) {
        if (path.startsWith("/")) {
          throw new Error(`SDK path must be relative: ${path}`);
        }
        calls.listed.push(path);
        return options.listings?.get(path) ??
          options.listings?.get(`/${path}`) ??
          [];
      },
      async downloadFile(path: string) {
        if (path.startsWith("/")) {
          throw new Error(`SDK path must be relative: ${path}`);
        }
        calls.downloaded.push(path);
        const content = options.downloads?.get(path) ??
          options.downloads?.get(`/${path}`);
        if (!content) throw new Error(`Missing fake download: ${path}`);
        return content;
      },
      async getFileDetails(path: string) {
        if (path.startsWith("/")) {
          throw new Error(`SDK path must be relative: ${path}`);
        }
        const parent = path.slice(0, path.lastIndexOf("/"));
        const name = path.slice(path.lastIndexOf("/") + 1);
        const info = (options.listings?.get(parent) ??
          options.listings?.get(`/${parent}`))
          ?.find((entry) => entry.name === name);
        if (info) return info;
        const content = options.downloads?.get(path) ??
          options.downloads?.get(`/${path}`);
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
            if (options.ptyWaitNever) {
              return new Promise<{
                exitCode?: number;
                error?: string;
              }>(() => undefined);
            }
            return { exitCode: options.ptyExitCode ?? 0 };
          },
          async kill() {
            calls.ptyKill++;
            if (options.ptyKillError) throw options.ptyKillError;
          },
          async disconnect() {
            calls.ptyDisconnect++;
            if (options.ptyDisconnectError) {
              throw options.ptyDisconnectError;
            }
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

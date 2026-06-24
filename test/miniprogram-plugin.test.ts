import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, relative, resolve } from "node:path";

import { GateCore } from "../src/gate.js";
import type {
  CommandExecutionRequest,
  ExecutionTarget,
  HttpExecutionRequest,
} from "../src/harness/execution.js";
import { miniprogramPlugin } from "../src/plugins/miniprogram.js";

function unusedRequest(_request: HttpExecutionRequest): Promise<never> {
  return Promise.reject(new Error("HTTP execution was not expected"));
}

function fakeExecution(
  response: (request: CommandExecutionRequest) => {
    executionId?: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    error?: string;
  },
): { execution: ExecutionTarget; calls: CommandExecutionRequest[] } {
  const calls: CommandExecutionRequest[] = [];
  return {
    calls,
    execution: {
      async execute(request) {
        calls.push(request);
        const result = response(request);
        return {
          executionId: result.executionId ?? request.executionId,
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          durationMs: result.durationMs ?? 5,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      },
      request: unusedRequest,
    },
  };
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a TCP port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function installFakeAutomationWebSocket(options: {
  endpoint?: string;
  readyAfterSends?: number;
} = {}): { restore: () => void; sends: () => number } {
  const globalWithWebSocket = globalThis as Record<string, unknown>;
  const originalWebSocket = globalWithWebSocket.WebSocket;
  const readyAfterSends = options.readyAfterSends ?? 1;
  let sends = 0;

  class FakeAutomationWebSocket {
    onopen: (() => void) | undefined;
    onmessage: ((event: { data: string }) => void) | undefined;
    onerror: ((event: unknown) => void) | undefined;
    onclose: (() => void) | undefined;

    constructor(readonly url: string) {
      if (options.endpoint) assert.equal(url, options.endpoint);
      setTimeout(() => this.onopen?.(), 0);
    }

    send(payload: string): void {
      sends += 1;
      const request = JSON.parse(payload) as { id: unknown };
      const result = sends < readyAfterSends
        ? { version: "2.01.2510290" }
        : { version: "2.01.2510290", SDKVersion: "3.15.2" };
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
      }, 0);
    }

    close(): void {
      this.onclose?.();
    }
  }

  globalWithWebSocket.WebSocket = FakeAutomationWebSocket;
  return {
    restore() {
      if (originalWebSocket === undefined) {
        Reflect.deleteProperty(globalWithWebSocket, "WebSocket");
      } else {
        globalWithWebSocket.WebSocket = originalWebSocket;
      }
    },
    sends: () => sends,
  };
}

function websocketAcceptKey(key: string): string {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function decodeWebSocketTextFrame(buffer: Buffer): string | undefined {
  if (buffer.length < 2) return undefined;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127) return undefined;
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return payload.toString("utf8");
}

function encodeWebSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

test("miniprogram plugin registers under a stable type", () => {
  const gate = new GateCore().use(miniprogramPlugin);
  assert.deepEqual(gate.plugins(), ["miniprogram"]);
});

test("miniprogram plugin errors on invalid project or runner paths", async () => {
  const result = await miniprogramPlugin.run(
    {
      id: "mp.invalid",
      type: "miniprogram",
      projectPath: "../dist",
      runner: "/tmp/runner.js",
    },
    { cwd: process.cwd() },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /路径|path|越界|absolute|绝对/);
});

test("miniprogram plugin rejects backslash traversal paths", async (t) => {
  const cases = [
    {
      name: "project path parent traversal",
      projectPath: "..\\outside",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "runner nested parent traversal",
      projectPath: "test/fixtures/mp-project",
      runner: "foo\\..\\..\\outside",
    },
    {
      name: "project path internal slash traversal",
      projectPath: "foo/../test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "project path internal backslash traversal",
      projectPath: "foo\\..\\test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "project path Windows drive absolute",
      projectPath: "C:\\outside",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "runner Windows drive absolute",
      projectPath: "test/fixtures/mp-project",
      runner: "C:/outside",
    },
    {
      name: "runner Windows drive relative",
      projectPath: "test/fixtures/mp-project",
      runner: "C:outside",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const result = await miniprogramPlugin.run(
        {
          id: `mp.invalid.${testCase.name}`,
          type: "miniprogram",
          projectPath: testCase.projectPath,
          runner: testCase.runner,
        },
        { cwd: process.cwd() },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", /路径|path|越界|absolute|绝对/);
    });
  }
});

test("miniprogram plugin classifies runner exit 0 as pass", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.pass",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args, [resolve(process.cwd(), "test/fixtures/miniprogram-runner.js")]);
  assert.deepEqual(Object.keys(calls[0]!.env ?? {}).sort(), [
    "HARNESS_MINIPROGRAM_PROJECT",
    "HARNESS_MINIPROGRAM_PROJECT_ABS",
    "HARNESS_MINIPROGRAM_WS_ENDPOINT",
    "NODE_PATH",
  ]);
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, "test/fixtures/mp-project");
  assert.equal(
    calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT_ABS,
    resolve(process.cwd(), "test/fixtures/mp-project"),
  );
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:9420");
});

test("miniprogram plugin exposes Harness-owned automator dependency to runner", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.automator.path",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  const nodePath = calls[0]!.env?.NODE_PATH;
  assert.ok(nodePath, "runner should receive NODE_PATH");
  assert.ok(
    nodePath.split(delimiter).some((entry) => entry.endsWith("node_modules")),
    `NODE_PATH should include a node_modules directory: ${nodePath}`,
  );
});

test("miniprogram plugin executes accepted in-workspace symlinks by real path", async () => {
  const projectReal = mkdtempSync(`${process.cwd()}/test/fixtures/mp-project-real-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-real-link-`);
  try {
    const runnerReal = `${linkDir}/runner-real.js`;
    writeFileSync(`${projectReal}/project.config.json`, "{}\n");
    writeFileSync(runnerReal, "process.exit(0)\n");
    symlinkSync(projectReal, `${linkDir}/project-link`);
    symlinkSync(runnerReal, `${linkDir}/runner-link.js`);

    const projectPath = relative(process.cwd(), `${linkDir}/project-link`);
    const runnerPath = relative(process.cwd(), `${linkDir}/runner-link.js`);
    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.symlink.accepted",
        type: "miniprogram",
        projectPath,
        runner: runnerPath,
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "pass");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, [runnerReal]);
    assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, projectPath);
    assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT_ABS, projectReal);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(projectReal, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects a directory runner before execution", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.runner.directory",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /runner|文件|file/i);
  assert.equal(calls.length, 0);
});

test("miniprogram plugin rejects a file project path before execution", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.project.file",
      type: "miniprogram",
      projectPath: "test/fixtures/miniprogram-runner.js",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /项目目录|directory|目录/);
  assert.equal(calls.length, 0);
});

test("miniprogram plugin rejects a directory project.config.json before execution", async () => {
  const projectAbs = mkdtempSync(`${process.cwd()}/test/fixtures/mp-config-dir-`);
  try {
    mkdirSync(`${projectAbs}/project.config.json`);
    const projectPath = relative(process.cwd(), projectAbs);
    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.project.config.directory",
        type: "miniprogram",
        projectPath,
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /project\.config\.json|配置|文件|file/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(projectAbs, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects runner symlink escape before execution", async () => {
  const outsideDir = mkdtempSync(`${tmpdir()}/mp-runner-outside-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-runner-link-`);
  try {
    const outsideRunner = `${outsideDir}/runner.js`;
    writeFileSync(outsideRunner, "process.exit(0)\n");
    symlinkSync(outsideRunner, `${linkDir}/runner.js`);

    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.runner.symlink.escape",
        type: "miniprogram",
        projectPath: "test/fixtures/mp-project",
        runner: relative(process.cwd(), `${linkDir}/runner.js`),
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /runner|工作区|workspace|越界|symlink|符号链接/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects project path symlink escape before execution", async () => {
  const outsideProject = mkdtempSync(`${tmpdir()}/mp-project-outside-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-project-link-`);
  try {
    writeFileSync(`${outsideProject}/project.config.json`, "{}\n");
    symlinkSync(outsideProject, `${linkDir}/project`);

    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.project.symlink.escape",
        type: "miniprogram",
        projectPath: relative(process.cwd(), `${linkDir}/project`),
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /项目|工作区|workspace|越界|symlink|符号链接/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(outsideProject, { recursive: true, force: true });
  }
});

test("miniprogram plugin classifies runner non-zero as fail", async () => {
  const { execution } = fakeExecution(() => ({
    exitCode: 7,
    stdout: "home title mismatch\nline 2\nline 3\nline 4\nline 5",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.fail",
      type: "miniprogram",
      scenario: "首页契约必须通过",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.what ?? "", /退出码 7/);
  assert.match(result.violations[0]?.why ?? "", /首页契约/);
  assert.match(result.violations[0]?.how ?? "", /home title mismatch/);
  assert.doesNotMatch(result.violations[0]?.how ?? "", /line 5/);
});

test("miniprogram plugin rejects mismatched or incomplete evidence as error", async () => {
  const { execution } = fakeExecution(() => ({
    executionId: "forged",
    exitCode: 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.evidence",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /ID|不匹配|不可信/);
});

test("miniprogram plugin rejects incomplete or errored runner evidence as error", async (t) => {
  const cases = [
    {
      name: "null exit code",
      response: () => ({ exitCode: null }),
      match: /退出码|证据|不可信/,
    },
    {
      name: "invalid duration",
      response: () => ({ exitCode: 0, durationMs: -1 }),
      match: /耗时|证据|不可信/,
    },
    {
      name: "execution target error",
      response: () => ({ exitCode: null, error: "remote spawn failed" }),
      match: /remote spawn failed/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { execution } = fakeExecution(testCase.response);
      const result = await miniprogramPlugin.run(
        {
          id: `mp.evidence.${testCase.name}`,
          type: "miniprogram",
          projectPath: "test/fixtures/mp-project",
          runner: "test/fixtures/miniprogram-runner.js",
          devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
        },
        { cwd: process.cwd(), execution },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", testCase.match);
    });
  }
});

test("miniprogram plugin starts managed DevTools before runner", async () => {
  const { execution, calls } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 0 : 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.managed",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
        trustProject: true,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.command, "/Applications/WeChatDevTools/cli");
  assert.deepEqual(calls[0]!.args, ["islogin"]);
  assert.deepEqual(calls[0]!.env, process.env.HOME ? { HOME: process.env.HOME } : {});
  assert.deepEqual(calls[1]!.args, [
    "auto",
    "--project",
    resolve(process.cwd(), "test/fixtures/mp-project"),
    "--auto-port",
    "19420",
    "--trust-project",
  ]);
  assert.equal(calls[2]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:19420");
  assert.equal(calls[2]!.env?.HARNESS_MINIPROGRAM_DEVTOOLS_PORT, "19420");
});

test("miniprogram plugin waits for managed DevTools automation protocol before runner", async () => {
  const port = await freeTcpPort();
  const root = mkdtempSync(`${process.cwd()}/test/fixtures/mp-managed-ready-`);
  const fakeWebSocket = installFakeAutomationWebSocket({ endpoint: `ws://127.0.0.1:${port}` });
  try {
    const cliPath = `${root}/cli.sh`;
    const projectPath = `${root}/project`;
    const runnerPath = `${root}/runner.cjs`;
    mkdirSync(projectPath);
    writeFileSync(`${projectPath}/project.config.json`, "{}\n");
    writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(runnerPath, "process.exit(0)\n");
    chmodSync(cliPath, 0o755);

    const result = await miniprogramPlugin.run(
      {
        id: "mp.managed.ready",
        type: "miniprogram",
        projectPath: relative(process.cwd(), projectPath),
        runner: relative(process.cwd(), runnerPath),
        timeoutMs: 2000,
        devtools: {
          mode: "managed",
          cliPath,
          autoPort: port,
        },
      },
      { cwd: process.cwd() },
    );

    assert.equal(result.status, "pass");
    assert.equal(fakeWebSocket.sends(), 1);
  } finally {
    fakeWebSocket.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("miniprogram plugin retries until managed DevTools automation protocol reports SDKVersion", async () => {
  const root = mkdtempSync(`${process.cwd()}/test/fixtures/mp-managed-protocol-`);
  const fakeWebSocket = installFakeAutomationWebSocket({
    endpoint: "ws://127.0.0.1:19420",
    readyAfterSends: 3,
  });
  try {
    const cliPath = `${root}/cli.sh`;
    const projectPath = `${root}/project`;
    const runnerPath = `${root}/runner.cjs`;
    mkdirSync(projectPath);
    writeFileSync(`${projectPath}/project.config.json`, "{}\n");
    writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(runnerPath, "process.exit(0)\n");
    chmodSync(cliPath, 0o755);

    const result = await miniprogramPlugin.run(
      {
        id: "mp.managed.protocol",
        type: "miniprogram",
        projectPath: relative(process.cwd(), projectPath),
        runner: relative(process.cwd(), runnerPath),
        timeoutMs: 1000,
        devtools: {
          mode: "managed",
          cliPath,
          autoPort: 19420,
        },
      },
      { cwd: process.cwd() },
    );

    assert.equal(result.status, "pass");
    assert.equal(fakeWebSocket.sends(), 3);
  } finally {
    fakeWebSocket.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("miniprogram plugin probes automation protocol when global WebSocket is unavailable", async () => {
  const port = await freeTcpPort();
  const root = mkdtempSync(`${process.cwd()}/test/fixtures/mp-managed-raw-ws-`);
  const globalWithWebSocket = globalThis as Record<string, unknown>;
  const originalWebSocket = globalWithWebSocket.WebSocket;
  let protocolRequests = 0;
  const server = createServer((socket) => {
    let handshook = false;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!handshook) {
        const request = pending.toString("utf8");
        const headerEnd = request.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const key = request.match(/^Sec-WebSocket-Key: (.+)$/im)?.[1]?.trim();
        assert.ok(key);
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
          "",
          "",
        ].join("\r\n"));
        pending = pending.subarray(headerEnd + 4);
        handshook = true;
      }

      const text = decodeWebSocketTextFrame(pending);
      if (!text) return;
      protocolRequests += 1;
      const request = JSON.parse(text) as { id: unknown };
      socket.write(encodeWebSocketTextFrame(JSON.stringify({
        id: request.id,
        result: { version: "2.01.2510290", SDKVersion: "3.15.2" },
      })));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  Reflect.deleteProperty(globalWithWebSocket, "WebSocket");
  try {
    const cliPath = `${root}/cli.sh`;
    const projectPath = `${root}/project`;
    const runnerPath = `${root}/runner.cjs`;
    mkdirSync(projectPath);
    writeFileSync(`${projectPath}/project.config.json`, "{}\n");
    writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(runnerPath, "process.exit(0)\n");
    chmodSync(cliPath, 0o755);

    const result = await miniprogramPlugin.run(
      {
        id: "mp.managed.raw-ws",
        type: "miniprogram",
        projectPath: relative(process.cwd(), projectPath),
        runner: relative(process.cwd(), runnerPath),
        timeoutMs: 2000,
        devtools: {
          mode: "managed",
          cliPath,
          autoPort: port,
        },
      },
      { cwd: process.cwd() },
    );

    assert.equal(result.status, "pass");
    assert.equal(protocolRequests, 1);
  } finally {
    if (originalWebSocket === undefined) {
      Reflect.deleteProperty(globalWithWebSocket, "WebSocket");
    } else {
      globalWithWebSocket.WebSocket = originalWebSocket;
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("miniprogram plugin uses managed DevTools defaults intentionally when omitted", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.managed.defaults",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ["islogin"]);
  assert.deepEqual(calls[1]!.args, [
    "auto",
    "--project",
    resolve(process.cwd(), "test/fixtures/mp-project"),
    "--auto-port",
    "9420",
    "--trust-project",
  ]);
  assert.equal(calls[2]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:9420");
  assert.equal(calls[2]!.env?.HARNESS_MINIPROGRAM_DEVTOOLS_PORT, "9420");
});

test("miniprogram plugin defaults omitted devtools to managed mode", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.devtools.omitted",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.command, "/Applications/wechatwebdevtools.app/Contents/MacOS/cli");
  assert.deepEqual(calls[0]!.args, ["islogin"]);
  assert.deepEqual(calls[1]!.args, [
    "auto",
    "--project",
    resolve(process.cwd(), "test/fixtures/mp-project"),
    "--auto-port",
    "9420",
    "--trust-project",
  ]);
});

test("miniprogram plugin honors managed trustProject false", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.managed.untrusted",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
        trustProject: false,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ["islogin"]);
  assert.deepEqual(calls[1]!.args, [
    "auto",
    "--project",
    resolve(process.cwd(), "test/fixtures/mp-project"),
    "--auto-port",
    "19420",
  ]);
});

test("miniprogram plugin starts managed DevTools with real project path for symlink project", async () => {
  const projectReal = mkdtempSync(`${process.cwd()}/test/fixtures/mp-managed-project-real-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-managed-link-`);
  try {
    writeFileSync(`${projectReal}/project.config.json`, "{}\n");
    symlinkSync(projectReal, `${linkDir}/project-link`);

    const projectPath = relative(process.cwd(), `${linkDir}/project-link`);
    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.managed.symlink.project",
        type: "miniprogram",
        projectPath,
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: {
          mode: "managed",
          cliPath: "/Applications/WeChatDevTools/cli",
          autoPort: 19420,
        },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "pass");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]!.args, ["islogin"]);
    assert.deepEqual(calls[1]!.args, [
      "auto",
      "--project",
      projectReal,
      "--auto-port",
      "19420",
      "--trust-project",
    ]);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(projectReal, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects malformed present devtools fields before execution", async (t) => {
  const cases = [
    { name: "devtools string", devtools: "managed" },
    { name: "devtools null", devtools: null },
    { name: "unknown mode", devtools: { mode: "auto" } },
    { name: "numeric cliPath", devtools: { mode: "managed", cliPath: 7 } },
    { name: "string trustProject", devtools: { mode: "managed", trustProject: "true" } },
    { name: "numeric wsEndpoint", devtools: { mode: "connect", wsEndpoint: 9420 } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
      const result = await miniprogramPlugin.run(
        {
          id: `mp.devtools.malformed.${testCase.name}`,
          type: "miniprogram",
          projectPath: "test/fixtures/mp-project",
          runner: "test/fixtures/miniprogram-runner.js",
          devtools: testCase.devtools,
        },
        { cwd: process.cwd(), execution },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", /devtools|mode|cliPath|trustProject|wsEndpoint/i);
      assert.equal(calls.length, 0);
    });
  }
});

test("miniprogram plugin does not forward ambient env to local managed DevTools startup", async () => {
  const cliDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-devtools-cli-`);
  const cliPath = `${cliDir}/cli.js`;
  const originalSecret = process.env.HARNESS_LEAK_TEST_SECRET;
  const fakeWebSocket = installFakeAutomationWebSocket({ endpoint: "ws://127.0.0.1:19420" });
  try {
    writeFileSync(
      cliPath,
      [
        "#!/bin/sh",
        "if [ -n \"$HARNESS_LEAK_TEST_SECRET\" ]; then",
        "  echo 'ambient env leaked' >&2",
        "  exit 3",
        "fi",
        "PORT=\"\"",
        "while [ $# -gt 0 ]; do",
        "  if [ \"$1\" = \"--auto-port\" ]; then",
        "    shift",
        "    PORT=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "if [ -n \"$PORT\" ]; then",
        `  \"${process.execPath}\" -e '`,
        "const { createServer } = require(\"node:net\");",
        "const port = Number(process.argv[1]);",
        "const server = createServer((socket) => socket.end());",
        "server.listen(port, \"127.0.0.1\", () => {",
        "  setTimeout(() => server.close(() => process.exit(0)), 2000);",
        "});",
        "' \"$PORT\" >/dev/null 2>&1 &",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(cliPath, 0o755);
    process.env.HARNESS_LEAK_TEST_SECRET = "contract-controlled-cli-must-not-see-this";

    const result = await miniprogramPlugin.run(
      {
        id: "mp.managed.local-env",
        type: "miniprogram",
        projectPath: "test/fixtures/mp-project",
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: {
          mode: "managed",
          cliPath,
          autoPort: 19420,
        },
      },
      { cwd: process.cwd() },
    );

    assert.equal(result.status, "pass");
    assert.doesNotMatch(result.errorReason ?? "", /ambient env leaked/);
    assert.equal(fakeWebSocket.sends(), 1);
  } finally {
    fakeWebSocket.restore();
    if (originalSecret === undefined) {
      delete process.env.HARNESS_LEAK_TEST_SECRET;
    } else {
      process.env.HARNESS_LEAK_TEST_SECRET = originalSecret;
    }
    rmSync(cliDir, { recursive: true, force: true });
  }
});

test("miniprogram plugin reports managed DevTools startup failure as error", async () => {
  const { execution, calls } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 2 : 0,
    stderr: request.command === "/Applications/WeChatDevTools/cli" ? "trust failed" : "",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.devtools-error",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /DevTools|trust failed|退出码 2/);
  assert.equal(calls.length, 1);
});

test("miniprogram plugin rejects managed DevTools startup evidence errors before runner", async (t) => {
  const cases = [
    {
      name: "mismatched executionId",
      response: () => ({ executionId: "forged", exitCode: 0 }),
      match: /ID|不匹配|不可信/,
    },
    {
      name: "execution target error",
      response: () => ({ exitCode: null, error: "remote spawn failed" }),
      match: /remote spawn failed/,
    },
    {
      name: "null exit code",
      response: () => ({ exitCode: null }),
      match: /退出码|证据|不可信/,
    },
    {
      name: "invalid exit code",
      response: () => ({ exitCode: 1.5 }),
      match: /退出码|证据|不可信/,
    },
    {
      name: "invalid duration",
      response: () => ({ exitCode: 0, durationMs: -1 }),
      match: /耗时|证据|不可信/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { execution, calls } = fakeExecution(testCase.response);
      const result = await miniprogramPlugin.run(
        {
          id: `mp.devtools.evidence.${testCase.name}`,
          type: "miniprogram",
          projectPath: "test/fixtures/mp-project",
          runner: "test/fixtures/miniprogram-runner.js",
          devtools: {
            mode: "managed",
            cliPath: "/Applications/WeChatDevTools/cli",
            autoPort: 19420,
          },
        },
        { cwd: process.cwd(), execution },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", testCase.match);
      assert.equal(calls.length, 1);
    });
  }
});

test("miniprogram plugin rejects invalid managed DevTools autoPort before execution", async (t) => {
  const cases = [
    { name: "zero", autoPort: 0 },
    { name: "negative", autoPort: -1 },
    { name: "non-integer", autoPort: 19420.5 },
    { name: "NaN", autoPort: Number.NaN },
    { name: "too large", autoPort: 65536 },
    { name: "string", autoPort: "19420" },
    { name: "null", autoPort: null },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
      const result = await miniprogramPlugin.run(
        {
          id: `mp.devtools.port.${testCase.name}`,
          type: "miniprogram",
          projectPath: "test/fixtures/mp-project",
          runner: "test/fixtures/miniprogram-runner.js",
          devtools: {
            mode: "managed",
            cliPath: "/Applications/WeChatDevTools/cli",
            autoPort: testCase.autoPort,
          },
        },
        { cwd: process.cwd(), execution },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", /autoPort|port|端口/);
      assert.equal(calls.length, 0);
    });
  }
});

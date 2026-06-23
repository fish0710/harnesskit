import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import {
  commandEvidenceError,
  executionId,
  localExecutionTarget,
} from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

interface DevtoolsConfig {
  mode: "managed" | "connect";
  cliPath?: string;
  autoPort?: number;
  trustProject?: boolean;
  wsEndpoint?: string;
}

type DevtoolsParseResult =
  | { ok: true; config: DevtoolsConfig }
  | { ok: false; errorReason: string };

export interface MiniProgramContract extends Contract {
  projectPath?: unknown;
  runner?: unknown;
  devtools?: unknown;
  expectExit?: unknown;
  timeoutMs?: unknown;
}

const DEFAULT_DEVTOOLS_CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const DEFAULT_AUTO_PORT = 9420;
const DEFAULT_DEVTOOLS_READY_TIMEOUT_MS = 30_000;
const DEVTOOLS_READY_CONNECT_TIMEOUT_MS = 500;
const DEVTOOLS_READY_PROTOCOL_TIMEOUT_MS = 1_000;
const DEVTOOLS_READY_POLL_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const slashPath = value.replaceAll("\\", "/");
  if (isAbsolute(value) || isAbsolute(slashPath) || /^[A-Za-z]:/.test(slashPath)) {
    return undefined;
  }
  if (slashPath.split("/").includes("..")) return undefined;
  const normalized = normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function boundedCommandOutput(stderr: string, stdout: string): string | undefined {
  const sections: string[] = [];
  const add = (label: string, value: string) => {
    const text = value.trim();
    if (!text) return;
    const bounded = text.split("\n").slice(0, 4).join("\n").slice(0, 1000);
    sections.push(`${label}:\n${bounded}`);
  };
  add("stderr", stderr);
  add("stdout", stdout);
  return sections.length ? sections.join("\n") : undefined;
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function realPathInside(root: string, path: string): string | undefined {
  const resolved = realPath(path);
  if (!resolved || !isPathInside(root, resolved)) return undefined;
  return resolved;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isValidTcpPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseDevtools(value: unknown): DevtoolsParseResult {
  if (value === undefined) return { ok: true, config: { mode: "managed" } };
  if (!isRecord(value)) {
    return { ok: false, errorReason: "miniprogram devtools 必须是对象" };
  }

  let mode: "managed" | "connect" = "managed";
  if (hasOwn(value, "mode")) {
    if (value.mode !== "managed" && value.mode !== "connect") {
      return { ok: false, errorReason: "miniprogram devtools.mode 必须是 managed 或 connect" };
    }
    mode = value.mode;
  }

  const config: DevtoolsConfig = { mode };
  if (hasOwn(value, "cliPath")) {
    if (typeof value.cliPath !== "string") {
      return { ok: false, errorReason: "miniprogram devtools.cliPath 必须是字符串" };
    }
    config.cliPath = value.cliPath;
  }
  if (hasOwn(value, "autoPort")) {
    if (typeof value.autoPort !== "number" || !isValidTcpPort(value.autoPort)) {
      return { ok: false, errorReason: "miniprogram devtools.autoPort 必须是有效 TCP 端口" };
    }
    config.autoPort = value.autoPort;
  }
  if (hasOwn(value, "trustProject")) {
    if (typeof value.trustProject !== "boolean") {
      return { ok: false, errorReason: "miniprogram devtools.trustProject 必须是布尔值" };
    }
    config.trustProject = value.trustProject;
  }
  if (hasOwn(value, "wsEndpoint")) {
    if (typeof value.wsEndpoint !== "string") {
      return { ok: false, errorReason: "miniprogram devtools.wsEndpoint 必须是字符串" };
    }
    config.wsEndpoint = value.wsEndpoint;
  }

  return { ok: true, config };
}

function managedDevtoolsEnv(): Record<string, string> {
  return typeof process.env.HOME === "string" && process.env.HOME !== ""
    ? { HOME: process.env.HOME }
    : {};
}

function devtoolsCommandTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? DEFAULT_DEVTOOLS_READY_TIMEOUT_MS, DEFAULT_DEVTOOLS_READY_TIMEOUT_MS);
}

function commandEvidenceOutput(evidence: { stderr: string; stdout: string }): string {
  return boundedCommandOutput(evidence.stderr, evidence.stdout) ?? "(无输出)";
}

function managedDevtoolsDiagnostics(
  warmup: { stderr: string; stdout: string } | undefined,
  auto: { stderr: string; stdout: string } | undefined,
): string {
  const sections: string[] = [];
  if (warmup) sections.push(`islogin ${commandEvidenceOutput(warmup)}`);
  if (auto) sections.push(`auto ${commandEvidenceOutput(auto)}`);
  return sections.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function tryTcpConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(DEVTOOLS_READY_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

type AutomationWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

type AutomationWebSocketConstructor = new (url: string) => AutomationWebSocket;

function automationWebSocketConstructor(): AutomationWebSocketConstructor | undefined {
  const value = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof value === "function" ? value as AutomationWebSocketConstructor : undefined;
}

function tryAutomationProtocolWithGlobalWebSocket(
  wsEndpoint: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const WebSocketConstructor = automationWebSocketConstructor();
  if (!WebSocketConstructor) return Promise.resolve(false);
  return new Promise((resolveReady) => {
    const requestId = `harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let socket: AutomationWebSocket | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        socket?.close();
      } catch {
        // Ignore cleanup failures while probing readiness.
      }
      resolveReady(ready);
    };

    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);

    try {
      socket = new WebSocketConstructor(wsEndpoint);
    } catch {
      finish(false);
      return;
    }

    socket.onopen = () => {
      try {
        socket?.send(JSON.stringify({ id: requestId, method: "Tool.getInfo", params: {} }));
      } catch {
        finish(false);
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          id?: unknown;
          result?: { SDKVersion?: unknown };
        };
        if (message.id !== requestId) return;
        finish(typeof message.result?.SDKVersion === "string" && message.result.SDKVersion.trim() !== "");
      } catch {
        finish(false);
      }
    };
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });
}

function encodeClientWebSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 65535) throw new Error("automation probe payload is too large");
  const mask = randomBytes(4);
  const lengthHeader = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([lengthHeader, mask, maskedPayload]);
}

function decodeWebSocketTextFrame(buffer: Buffer): string | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  if (opcode !== 0x1) return undefined;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    return undefined;
  }
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

function tryAutomationProtocolWithRawSocket(
  wsEndpoint: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(wsEndpoint);
  } catch {
    return Promise.resolve(false);
  }
  if (url.protocol !== "ws:") return Promise.resolve(false);

  return new Promise((resolveReady) => {
    const host = url.hostname.replace(/^\[(.*)]$/, "$1") || "127.0.0.1";
    const port = Number(url.port || 80);
    if (!isValidTcpPort(port)) {
      resolveReady(false);
      return;
    }

    const requestId = `harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const path = `${url.pathname || "/"}${url.search}`;
    const socket = createConnection({ host, port });
    let pending = Buffer.alloc(0);
    let handshook = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolveReady(ready);
    };

    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);

    socket.once("connect", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!handshook) {
        const headerEnd = pending.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = pending.subarray(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          finish(false);
          return;
        }
        const accept = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
        if (accept !== expectedAccept) {
          finish(false);
          return;
        }
        handshook = true;
        pending = pending.subarray(headerEnd + 4);
        socket.write(encodeClientWebSocketTextFrame(JSON.stringify({
          id: requestId,
          method: "Tool.getInfo",
          params: {},
        })));
      }

      const text = decodeWebSocketTextFrame(pending);
      if (!text) return;
      try {
        const message = JSON.parse(text) as {
          id?: unknown;
          result?: { SDKVersion?: unknown };
        };
        if (message.id !== requestId) return;
        finish(typeof message.result?.SDKVersion === "string" && message.result.SDKVersion.trim() !== "");
      } catch {
        finish(false);
      }
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function tryAutomationProtocol(wsEndpoint: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return automationWebSocketConstructor()
    ? tryAutomationProtocolWithGlobalWebSocket(wsEndpoint, timeoutMs, signal)
    : tryAutomationProtocolWithRawSocket(wsEndpoint, timeoutMs, signal);
}

async function waitForDevtoolsAutomation(
  wsEndpoint: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const budgetMs = Math.min(timeoutMs ?? DEFAULT_DEVTOOLS_READY_TIMEOUT_MS, DEFAULT_DEVTOOLS_READY_TIMEOUT_MS);
  const deadline = performance.now() + budgetMs;
  while (performance.now() <= deadline) {
    if (signal?.aborted) return false;
    const remainingMs = Math.max(1, Math.min(DEVTOOLS_READY_PROTOCOL_TIMEOUT_MS, deadline - performance.now()));
    if (await tryAutomationProtocol(wsEndpoint, remainingMs, signal)) return true;
    await sleep(DEVTOOLS_READY_POLL_MS);
  }
  return false;
}

async function waitForManagedDevtoolsPort(
  port: number,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  host = "127.0.0.1",
): Promise<boolean> {
  const wsHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return waitForDevtoolsAutomation(`ws://${wsHost}:${port}`, timeoutMs, signal);
}

async function waitForTcpPortClosed(
  port: number,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  host = "127.0.0.1",
): Promise<boolean> {
  const budgetMs = Math.min(timeoutMs ?? DEFAULT_DEVTOOLS_READY_TIMEOUT_MS, DEFAULT_DEVTOOLS_READY_TIMEOUT_MS);
  const deadline = performance.now() + budgetMs;
  while (performance.now() <= deadline) {
    if (signal?.aborted) return false;
    if (!await tryTcpConnect(host, port)) return true;
    await sleep(DEVTOOLS_READY_POLL_MS);
  }
  return false;
}

interface ManagedDevtoolsStartOutcome {
  error: CheckResult | undefined;
  autoCommandIssued: boolean;
}

async function startManagedDevtools(
  contract: Contract,
  ctx: RunContext,
  cliPath: string,
  projectAbs: string,
  port: number,
  trustProject: boolean,
  timeoutMs: number | undefined,
): Promise<ManagedDevtoolsStartOutcome> {
  const startedAt = performance.now();
  const commandTimeoutMs = devtoolsCommandTimeoutMs(timeoutMs);
  let autoCommandIssued = false;
  const warmupId = executionId();
  const warmupEvidence = await (ctx.execution ?? localExecutionTarget).execute({
    executionId: warmupId,
    command: cliPath,
    args: ["islogin"],
    cwd: ctx.cwd,
    timeoutMs: commandTimeoutMs,
    signal: ctx.signal,
    env: managedDevtoolsEnv(),
  });
  const warmupEvidenceError = commandEvidenceError(warmupId, warmupEvidence);
  if (warmupEvidenceError) {
    return {
      autoCommandIssued,
      error: {
        id: contract.id,
        type: "miniprogram",
        status: "error",
        durationMs: performance.now() - startedAt,
        violations: [],
        errorReason: `微信开发者工具预热失败或证据不可信: ${warmupEvidenceError}\n` +
          managedDevtoolsDiagnostics(warmupEvidence, undefined),
      },
    };
  }
  if (warmupEvidence.exitCode !== 0) {
    return {
      autoCommandIssued,
      error: {
        id: contract.id,
        type: "miniprogram",
        status: "error",
        durationMs: performance.now() - startedAt,
        violations: [],
        errorReason: `微信开发者工具预热退出码 ${warmupEvidence.exitCode}: ${commandEvidenceOutput(warmupEvidence)}`,
      },
    };
  }

  const args = [
    "auto",
    "--project",
    projectAbs,
    "--auto-port",
    String(port),
    ...(trustProject ? ["--trust-project"] : []),
  ];
  const id = executionId();
  autoCommandIssued = true;
  const evidence = await (ctx.execution ?? localExecutionTarget).execute({
    executionId: id,
    command: cliPath,
    args,
    cwd: ctx.cwd,
    timeoutMs: commandTimeoutMs,
    signal: ctx.signal,
    env: managedDevtoolsEnv(),
  });
  const evidenceError = commandEvidenceError(id, evidence);
  if (evidenceError) {
    return {
      autoCommandIssued,
      error: {
        id: contract.id,
        type: "miniprogram",
        status: "error",
        durationMs: performance.now() - startedAt,
        violations: [],
        errorReason: `微信开发者工具启动失败或证据不可信: ${evidenceError}\n` +
          managedDevtoolsDiagnostics(warmupEvidence, evidence),
      },
    };
  }
  if (evidence.exitCode !== 0) {
    return {
      autoCommandIssued,
      error: {
        id: contract.id,
        type: "miniprogram",
        status: "error",
        durationMs: performance.now() - startedAt,
        violations: [],
        errorReason: `微信开发者工具启动退出码 ${evidence.exitCode}: ${commandEvidenceOutput(evidence)}\n` +
          managedDevtoolsDiagnostics(warmupEvidence, evidence),
      },
    };
  }
  if (!ctx.execution) {
    const ready = await waitForManagedDevtoolsPort(port, timeoutMs, ctx.signal);
    if (!ready) {
      return {
        autoCommandIssued,
        error: {
          id: contract.id,
          type: "miniprogram",
          status: "error",
          durationMs: performance.now() - startedAt,
          violations: [],
          errorReason: `微信开发者工具自动化协议未就绪: ws://127.0.0.1:${port} 未返回 SDKVersion\n` +
            `project: ${projectAbs}\n` +
            managedDevtoolsDiagnostics(warmupEvidence, evidence),
        },
      };
    }
  }
  return { autoCommandIssued, error: undefined };
}

async function stopManagedDevtools(
  contract: Contract,
  ctx: RunContext,
  cliPath: string,
  port: number,
  timeoutMs: number | undefined,
): Promise<CheckResult | undefined> {
  const startedAt = performance.now();
  const id = executionId();
  const evidence = await (ctx.execution ?? localExecutionTarget).execute({
    executionId: id,
    command: cliPath,
    args: ["quit"],
    cwd: ctx.cwd,
    timeoutMs: devtoolsCommandTimeoutMs(timeoutMs),
    signal: ctx.signal,
    env: managedDevtoolsEnv(),
  });
  const evidenceError = commandEvidenceError(id, evidence);
  if (evidenceError) {
    return {
      id: contract.id,
      type: "miniprogram",
      status: "error",
      durationMs: performance.now() - startedAt,
      violations: [],
      errorReason: `微信开发者工具 doctor 清理失败或证据不可信: ${evidenceError}`,
    };
  }
  if (evidence.exitCode !== 0) {
    return {
      id: contract.id,
      type: "miniprogram",
      status: "error",
      durationMs: performance.now() - startedAt,
      violations: [],
      errorReason: `微信开发者工具 doctor 清理退出码 ${evidence.exitCode}: ${commandEvidenceOutput(evidence)}`,
    };
  }
  if (!ctx.execution) {
    const closed = await waitForTcpPortClosed(port, timeoutMs, ctx.signal);
    if (!closed) {
      return {
        id: contract.id,
        type: "miniprogram",
        status: "error",
        durationMs: performance.now() - startedAt,
        violations: [],
        errorReason: `微信开发者工具 doctor 清理后端口仍在监听: ws://127.0.0.1:${port}`,
      };
    }
  }
  return undefined;
}

function writeDoctorProject(root: string): void {
  writeFileSync(
    join(root, "project.config.json"),
    JSON.stringify({
      appid: "touristappid",
      compileType: "miniprogram",
      libVersion: "3.15.2",
      miniprogramRoot: "./",
      projectname: "harness-miniprogram-doctor",
      setting: {
        es6: true,
        minified: false,
        postcss: true,
        urlCheck: false,
      },
    }) + "\n",
  );
  writeFileSync(join(root, "app.json"), JSON.stringify({ pages: ["pages/index/index"] }) + "\n");
  writeFileSync(join(root, "app.js"), "App({})\n");
  writeFileSync(join(root, "app.wxss"), ".page-ready { padding: 24px; }\n");
  mkdirSync(join(root, "pages/index"), { recursive: true });
  writeFileSync(join(root, "pages/index/index.wxml"), "<view class=\"page-ready\">ok</view>\n");
  writeFileSync(join(root, "pages/index/index.js"), "Page({})\n");
  writeFileSync(join(root, "pages/index/index.json"), "{}\n");
  writeFileSync(join(root, "pages/index/index.wxss"), ".page-ready { color: #1677ff; }\n");
}

function tcpPortFromWsEndpoint(wsEndpoint: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(wsEndpoint);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    if (!isValidTcpPort(port)) return undefined;
    return { host: url.hostname || "127.0.0.1", port };
  } catch {
    return undefined;
  }
}

export async function checkMiniProgramHostReadiness(
  contract: MiniProgramContract,
  ctx: RunContext,
): Promise<string | undefined> {
  const devtoolsParse = parseDevtools(contract.devtools);
  if (!devtoolsParse.ok) return devtoolsParse.errorReason;
  const devtools = devtoolsParse.config;
  const timeoutMs = typeof contract.timeoutMs === "number" ? contract.timeoutMs : undefined;
  if (devtools.mode === "connect") {
    if (!devtools.wsEndpoint) return "miniprogram devtools requires a WebSocket endpoint";
    if (ctx.execution) return undefined;
    const target = tcpPortFromWsEndpoint(devtools.wsEndpoint);
    if (!target) return `miniprogram devtools.wsEndpoint 无法解析: ${devtools.wsEndpoint}`;
    const ready = await waitForDevtoolsAutomation(devtools.wsEndpoint, timeoutMs, ctx.signal);
    return ready ? undefined : `微信开发者工具自动化协议未就绪: ${devtools.wsEndpoint} 未返回 SDKVersion`;
  }

  const cliPath = devtools.cliPath ?? DEFAULT_DEVTOOLS_CLI;
  if (!existsSync(cliPath) && !ctx.execution) {
    return `微信开发者工具 CLI 不存在: ${cliPath}`;
  }
  const port = devtools.autoPort ?? DEFAULT_AUTO_PORT;
  const root = mkdtempSync(join(tmpdir(), "harness-miniprogram-doctor-"));
  let removeDoctorProject = true;
  try {
    writeDoctorProject(root);
    const result = await startManagedDevtools(
      contract,
      ctx,
      cliPath,
      root,
      port,
      devtools.trustProject !== false,
      timeoutMs,
    );
    let cleanupError: CheckResult | undefined;
    if (result.autoCommandIssued) {
      cleanupError = await stopManagedDevtools(contract, ctx, cliPath, port, timeoutMs);
      if (cleanupError) removeDoctorProject = false;
    }
    return result.error?.errorReason ?? cleanupError?.errorReason;
  } finally {
    if (removeDoctorProject) rmSync(root, { recursive: true, force: true });
  }
}

export const miniprogramPlugin: Plugin = {
  type: "miniprogram",

  async run(contract: MiniProgramContract, ctx: RunContext): Promise<CheckResult> {
    const projectPath = safeRelativePath(contract.projectPath);
    const runner = safeRelativePath(contract.runner);
    if (!projectPath || !runner) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "miniprogram 契约的 projectPath 和 runner 必须是工作区内相对路径",
      };
    }

    const projectAbs = resolve(ctx.cwd, projectPath);
    const runnerAbs = resolve(ctx.cwd, runner);
    const projectConfigAbs = resolve(projectAbs, "project.config.json");
    const workspaceRoot = realPath(ctx.cwd);
    if (!workspaceRoot) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "工作区路径不存在或无法解析",
      };
    }
    if (!existsSync(projectAbs)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序项目目录不存在: ${projectPath}`,
      };
    }
    const projectReal = realPathInside(workspaceRoot, projectAbs);
    if (!projectReal) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序项目路径必须位于工作区内: ${projectPath}`,
      };
    }
    if (!isDirectory(projectReal)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序项目路径必须是目录: ${projectPath}`,
      };
    }
    if (!existsSync(projectConfigAbs)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序项目缺少 project.config.json: ${projectPath}`,
      };
    }
    const projectConfigReal = realPathInside(workspaceRoot, projectConfigAbs);
    if (!projectConfigReal) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序 project.config.json 必须位于工作区内: ${projectPath}`,
      };
    }
    if (!isRegularFile(projectConfigReal)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序 project.config.json 必须是文件: ${projectPath}`,
      };
    }
    if (!existsSync(runnerAbs)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序 runner 不存在: ${runner}`,
      };
    }
    const runnerReal = realPathInside(workspaceRoot, runnerAbs);
    if (!runnerReal) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序 runner 必须位于工作区内: ${runner}`,
      };
    }
    if (!isRegularFile(runnerReal)) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序 runner 必须是文件: ${runner}`,
      };
    }

    const devtoolsParse = parseDevtools(contract.devtools);
    if (!devtoolsParse.ok) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: devtoolsParse.errorReason,
      };
    }
    const devtools = devtoolsParse.config;
    const expectedExit = typeof contract.expectExit === "number" ? contract.expectExit : 0;
    const timeoutMs = typeof contract.timeoutMs === "number" ? contract.timeoutMs : undefined;
    let wsEndpoint = devtools.wsEndpoint;
    let devtoolsPort: number | undefined;
    if (devtools.mode === "managed") {
      const cliPath = devtools.cliPath ?? DEFAULT_DEVTOOLS_CLI;
      if (!existsSync(cliPath) && !ctx.execution) {
        return {
          id: contract.id,
          type: this.type,
          status: "error",
          durationMs: 0,
          violations: [],
          errorReason: `微信开发者工具 CLI 不存在: ${cliPath}`,
        };
      }
      devtoolsPort = devtools.autoPort ?? DEFAULT_AUTO_PORT;
      const startup = await startManagedDevtools(
        contract,
        ctx,
        cliPath,
        projectReal,
        devtoolsPort,
        devtools.trustProject !== false,
        timeoutMs,
      );
      if (startup.error) return startup.error;
      wsEndpoint = `ws://127.0.0.1:${devtoolsPort}`;
    }
    if (!wsEndpoint) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "miniprogram devtools requires a WebSocket endpoint",
      };
    }

    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: process.execPath,
      args: [runnerReal],
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      env: {
        HARNESS_MINIPROGRAM_PROJECT: projectPath,
        HARNESS_MINIPROGRAM_PROJECT_ABS: projectReal,
        HARNESS_MINIPROGRAM_WS_ENDPOINT: wsEndpoint,
        ...(devtoolsPort !== undefined
          ? { HARNESS_MINIPROGRAM_DEVTOOLS_PORT: String(devtoolsPort) }
          : {}),
      },
    });
    const durationMs = evidence.durationMs;
    const evidenceError = commandEvidenceError(id, evidence);
    if (evidenceError) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs,
        violations: [],
        errorReason: `小程序 runner 无法启动或执行证据不可信: ${evidenceError}`,
      };
    }
    if (evidence.exitCode === expectedExit) {
      return { id: contract.id, type: this.type, status: "pass", durationMs, violations: [] };
    }
    return {
      id: contract.id,
      type: this.type,
      status: "fail",
      durationMs,
      violations: [{
        what: `小程序 runner 退出码 ${evidence.exitCode}，期望 ${expectedExit}`,
        why: contract.scenario ? String(contract.scenario) : "小程序行为未达契约",
        how: boundedCommandOutput(evidence.stderr, evidence.stdout) ?? "检查小程序自动化 runner 输出",
        ref: typeof contract.ref === "string" ? contract.ref : undefined,
      }],
    };
  },
};

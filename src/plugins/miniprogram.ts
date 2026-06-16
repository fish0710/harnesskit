import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

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

interface MiniProgramContract extends Contract {
  projectPath?: unknown;
  runner?: unknown;
  devtools?: unknown;
  expectExit?: unknown;
  timeoutMs?: unknown;
}

const DEFAULT_DEVTOOLS_CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const DEFAULT_AUTO_PORT = 9420;

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

async function startManagedDevtools(
  contract: Contract,
  ctx: RunContext,
  cliPath: string,
  projectAbs: string,
  port: number,
  trustProject: boolean,
  timeoutMs: number | undefined,
): Promise<CheckResult | undefined> {
  const args = [
    "auto",
    "--project",
    projectAbs,
    "--auto-port",
    String(port),
    ...(trustProject ? ["--trust-project"] : []),
  ];
  const id = executionId();
  const evidence = await (ctx.execution ?? localExecutionTarget).execute({
    executionId: id,
    command: cliPath,
    args,
    cwd: ctx.cwd,
    timeoutMs,
    signal: ctx.signal,
    env: {},
  });
  const evidenceError = commandEvidenceError(id, evidence);
  if (evidenceError) {
    return {
      id: contract.id,
      type: "miniprogram",
      status: "error",
      durationMs: evidence.durationMs,
      violations: [],
      errorReason: `微信开发者工具启动失败或证据不可信: ${evidenceError}`,
    };
  }
  if (evidence.exitCode !== 0) {
    return {
      id: contract.id,
      type: "miniprogram",
      status: "error",
      durationMs: evidence.durationMs,
      violations: [],
      errorReason: `微信开发者工具启动退出码 ${evidence.exitCode}: ${
        boundedCommandOutput(evidence.stderr, evidence.stdout) ?? "(无输出)"
      }`,
    };
  }
  return undefined;
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
      const startupError = await startManagedDevtools(
        contract,
        ctx,
        cliPath,
        projectReal,
        devtoolsPort,
        devtools.trustProject !== false,
        timeoutMs,
      );
      if (startupError) return startupError;
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

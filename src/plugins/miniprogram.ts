import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import {
  commandEvidenceError,
  executionId,
  localExecutionTarget,
} from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

interface DevtoolsConfig {
  mode?: "managed" | "connect";
  cliPath?: string;
  autoPort?: number;
  trustProject?: boolean;
  wsEndpoint?: string;
}

interface MiniProgramContract extends Contract {
  projectPath?: unknown;
  runner?: unknown;
  devtools?: unknown;
  expectExit?: unknown;
  timeoutMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (isAbsolute(value)) return undefined;
  const normalized = normalize(value);
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

function parseDevtools(value: unknown): DevtoolsConfig {
  if (!isRecord(value)) return { mode: "managed" };
  const mode = value.mode === "connect" ? "connect" : "managed";
  return {
    mode,
    ...(typeof value.cliPath === "string" ? { cliPath: value.cliPath } : {}),
    ...(typeof value.autoPort === "number" ? { autoPort: value.autoPort } : {}),
    ...(typeof value.trustProject === "boolean" ? { trustProject: value.trustProject } : {}),
    ...(typeof value.wsEndpoint === "string" ? { wsEndpoint: value.wsEndpoint } : {}),
  };
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
    if (!existsSync(resolve(projectAbs, "project.config.json"))) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: `小程序项目缺少 project.config.json: ${projectPath}`,
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

    const devtools = parseDevtools(contract.devtools);
    if (devtools.mode === "managed") {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "managed DevTools mode will be implemented in the next task",
      };
    }
    if (!devtools.wsEndpoint) {
      return {
        id: contract.id,
        type: this.type,
        status: "error",
        durationMs: 0,
        violations: [],
        errorReason: "connect mode requires devtools.wsEndpoint",
      };
    }

    const expectedExit = typeof contract.expectExit === "number" ? contract.expectExit : 0;
    const timeoutMs = typeof contract.timeoutMs === "number" ? contract.timeoutMs : undefined;
    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).execute({
      executionId: id,
      command: process.execPath,
      args: [runner],
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      env: {
        ...process.env,
        HARNESS_MINIPROGRAM_PROJECT: projectPath,
        HARNESS_MINIPROGRAM_PROJECT_ABS: projectAbs,
        HARNESS_MINIPROGRAM_WS_ENDPOINT: devtools.wsEndpoint,
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

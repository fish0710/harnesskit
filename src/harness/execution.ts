import { randomUUID } from "node:crypto";

import { spawnCapture } from "../util/spawn.js";

export interface CommandExecutionRequest {
  executionId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandExecutionEvidence {
  executionId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface HttpExecutionRequest {
  executionId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpExecutionEvidence {
  executionId: string;
  status?: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  error?: string;
}

export interface ExecutionTarget {
  execute(request: CommandExecutionRequest): Promise<CommandExecutionEvidence>;
  request(request: HttpExecutionRequest): Promise<HttpExecutionEvidence>;
}

export function executionId(): string {
  return randomUUID();
}

export const localExecutionTarget: ExecutionTarget = {
  async execute(request) {
    const start = performance.now();
    const result = await spawnCapture(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      signal: request.signal,
    });
    return {
      executionId: request.executionId,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: performance.now() - start,
      ...(result.spawnError ? { error: result.spawnError } : {}),
    };
  },

  async request(request) {
    const start = performance.now();
    try {
      const timeoutSignal = request.timeoutMs !== undefined
        ? AbortSignal.timeout(request.timeoutMs)
        : undefined;
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal && timeoutSignal
          ? AbortSignal.any([request.signal, timeoutSignal])
          : request.signal ?? timeoutSignal,
      });
      return {
        executionId: request.executionId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
        durationMs: performance.now() - start,
      };
    } catch (error) {
      return {
        executionId: request.executionId,
        headers: {},
        body: "",
        durationMs: performance.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

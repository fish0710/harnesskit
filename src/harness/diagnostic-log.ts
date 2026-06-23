import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  at: string;
  level: DiagnosticLogLevel;
  phase: string;
  message: string;
  data?: unknown;
}

export interface DiagnosticLogger {
  readonly enabled: boolean;
  readonly path?: string;
  log(
    level: DiagnosticLogLevel,
    phase: string,
    message: string,
    data?: unknown,
  ): void;
  debug(phase: string, message: string, data?: unknown): void;
  info(phase: string, message: string, data?: unknown): void;
  warn(phase: string, message: string, data?: unknown): void;
  error(phase: string, message: string, data?: unknown): void;
  close(): void;
}

export interface CreateDiagnosticLoggerOptions {
  enabled: boolean;
  cwd: string;
  runId: string;
  now?: () => string;
  write?: (line: string) => void;
  redact?: (value: unknown) => unknown;
}

function assertSafeRunId(runId: string): void {
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    throw new Error("runId must be a non-empty safe path segment");
  }
}

export function diagnosticLogPath(cwd: string, runId: string): string {
  assertSafeRunId(runId);
  return join(cwd, ".harness", "runs", `${runId}.log.jsonl`);
}

function renderEntry(entry: DiagnosticLogEntry): string {
  const suffix = entry.data === undefined
    ? ""
    : ` ${JSON.stringify(entry.data)}`;
  return `[${entry.at}] ${entry.level} ${entry.phase} ${entry.message}${suffix}`;
}

export function createDiagnosticLogger(
  options: CreateDiagnosticLoggerOptions,
): DiagnosticLogger {
  if (!options.enabled) {
    return {
      enabled: false,
      log() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      close() {},
    };
  }

  const path = diagnosticLogPath(options.cwd, options.runId);
  mkdirSync(join(options.cwd, ".harness", "runs"), { recursive: true });
  const fd = openSync(path, "a");
  const now = options.now ?? (() => new Date().toISOString());
  const write = options.write ?? ((line: string) => console.log(line));
  const redact = options.redact ?? ((value: unknown) => value);
  let closed = false;

  const logger: DiagnosticLogger = {
    enabled: true,
    path,
    log(level, phase, message, data) {
      if (closed) return;
      const redacted = data === undefined ? undefined : redact(data);
      const entry: DiagnosticLogEntry = {
        at: now(),
        level,
        phase,
        message,
        ...(redacted === undefined ? {} : { data: redacted }),
      };
      write(renderEntry(entry));
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    },
    debug(phase, message, data) {
      logger.log("debug", phase, message, data);
    },
    info(phase, message, data) {
      logger.log("info", phase, message, data);
    },
    warn(phase, message, data) {
      logger.log("warn", phase, message, data);
    },
    error(phase, message, data) {
      logger.log("error", phase, message, data);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
  return logger;
}

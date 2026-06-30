import { Daytona, type FileInfo, type VolumeMount } from "@daytona/sdk";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type {
  CommandExecutionEvidence,
  ExecutionTarget,
  HttpExecutionEvidence,
} from "../execution.js";
import type {
  RemoteFileEntry,
  RemoteWorkspace,
} from "./workspace.js";
import {
  normalizeWorkspacePath,
  protectedFilesystemPathKey,
} from "./policy.js";
import type {
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxHandle,
  SandboxProvider,
  WorkspaceFile,
} from "./types.js";
import {
  getGateSnapshot,
  requireAgentSnapshot,
} from "./toolchain.js";

export const DEFAULT_DAYTONA_API_URL = "http://localhost:3000/api";
const CLAUDE_INVOKE =
  '"/usr/local/bin/claude" --dangerously-skip-permissions ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';
const CLAUDE_RESUME_INVOKE =
  '"/usr/local/bin/claude" --dangerously-skip-permissions ' +
  '--resume "$HARNESS_CLAUDE_SESSION_ID" ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeInlineScript(script: string): string {
  return `/usr/local/bin/node -e ${shellSingleQuote(script)}`;
}

function streamPersistingClaudeCommand(invoke: string): string {
  const streamReaderScript = [
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    "let inputFd;",
    "let input;",
    "let streamFd;",
    'const graceSeconds = Number(process.env.HARNESS_CLAUDE_RESULT_GRACE_SECONDS ?? "30");',
    'const graceMs = Number.isFinite(graceSeconds) && graceSeconds >= 0 ? graceSeconds * 1000 : 30000;',
    "let finalResultSuccess = false;",
    "let graceTimer;",
    "let finished = false;",
    "let reader;",
    "function clearGraceTimer() {",
    "  if (graceTimer) {",
    "    clearTimeout(graceTimer);",
    "    graceTimer = undefined;",
    "  }",
    "}",
    "function scheduleGraceTimer() {",
    "  clearGraceTimer();",
    "  graceTimer = setTimeout(() => {",
    "    try {",
    '      process.kill(Number(process.env.HARNESS_CLAUDE_PID), "SIGTERM");',
    '      fs.writeFileSync(process.env.HARNESS_CLAUDE_TERM_MARKER_PATH, "");',
    "    } catch {",
    "      // Claude may already have exited.",
    "    }",
    "    finish(0);",
    "  }, graceMs);",
    "}",
    "function writeDiagnostic(error) {",
    '  const message = error instanceof Error ? error.message : String(error);',
    '  const diagnostic = `[claude stream reader] ${message.slice(0, 1000)}\\n`;',
    "  try {",
    "    fs.writeFileSync(process.env.HARNESS_CLAUDE_READER_DIAGNOSTIC_PATH, diagnostic);",
    "  } catch {",
    "    // If the diagnostic handoff fails, stderr still preserves local detail.",
    "  }",
    "  fs.writeSync(2, diagnostic);",
    "}",
    "function fail(error) {",
    "  writeDiagnostic(error);",
    "  finish(1);",
    "}",
    "function closeStream() {",
    "  if (streamFd === undefined) return;",
    "  try {",
    "    fs.closeSync(streamFd);",
    "  } catch {",
    "    // The stream fd may already be closed during process shutdown.",
    "  }",
    "  streamFd = undefined;",
    "}",
    "function closeInput() {",
    "  if (input) input.destroy();",
    "  if (inputFd === undefined) return;",
    "  try {",
    "    fs.closeSync(inputFd);",
    "  } catch {",
    "    // The input fd may already be closed by the read stream.",
    "  }",
    "  inputFd = undefined;",
    "}",
    "function writeStatus(status) {",
    "  fs.writeFileSync(process.env.HARNESS_CLAUDE_READER_STATUS_PATH, String(status));",
    "}",
    "function finish(status) {",
    "  if (finished) return;",
    "  finished = true;",
    "  clearGraceTimer();",
    "  writeStatus(status);",
    "  if (reader) reader.close();",
    "  closeInput();",
    "  closeStream();",
    "  process.exit(status);",
    "}",
    "process.on('exit', closeStream);",
    "try {",
    '  inputFd = fs.openSync(process.env.HARNESS_CLAUDE_STDOUT_PIPE, "r");',
    '  input = fs.createReadStream(null, { fd: inputFd, autoClose: true });',
    '  streamFd = fs.openSync(process.env.HARNESS_CLAUDE_STREAM_PATH, "a");',
    '  reader = readline.createInterface({ input, crlfDelay: Infinity });',
    "  reader.on('line', (line) => {",
    "    try {",
    '      const output = line + "\\n";',
    "      fs.writeSync(1, output);",
    "      fs.writeSync(streamFd, output);",
    "      if (finalResultSuccess) scheduleGraceTimer();",
    "      let record;",
    "      try {",
    "        record = JSON.parse(line);",
    "      } catch {",
    "        return;",
    "      }",
    '      if (record === null || typeof record !== "object" || Array.isArray(record)) return;',
    '      if (record.type !== "result") return;',
    "      finalResultSuccess = record.is_error !== true;",
    "      if (finalResultSuccess) scheduleGraceTimer(); else clearGraceTimer();",
    "    } catch (error) {",
    "      fail(error);",
    "    }",
    "  });",
    "  reader.on('close', () => {",
    "    finish(finalResultSuccess ? 0 : 1);",
    "  });",
    "} catch (error) {",
    "  fail(error);",
    "}",
  ].join("\n");
  const streamScript = [
    "set -e",
    'mkdir -p "$(dirname "$HARNESS_CLAUDE_STREAM_PATH")"',
    'claude_tmp_dir="$(mktemp -d /tmp/harness-claude-${HARNESS_ATTEMPT:-0}.XXXXXX)"',
    'claude_stderr_path="$claude_tmp_dir/stderr.log"',
    'claude_stdout_pipe="$claude_tmp_dir/stdout.fifo"',
    'claude_reader_status_path="$claude_tmp_dir/reader.status"',
    'claude_reader_diagnostic_path="$claude_tmp_dir/reader.diagnostic"',
    'claude_term_marker_path="$claude_tmp_dir/claude.term"',
    'claude_kill_marker_path="$claude_tmp_dir/claude.kill"',
    'cleanup_tmp() { rm -rf "$claude_tmp_dir"; }',
    "trap cleanup_tmp EXIT",
    'mkfifo "$claude_stdout_pipe"',
    "set +e",
    "result_success=0",
    "killed_for_reader_failure=0",
    "claude_killer_pid=",
    "reader_killer_pid=",
    'terminate_claude() { if kill -0 "$claude_pid" 2>/dev/null; then if kill "$claude_pid" 2>/dev/null; then touch "$claude_term_marker_path"; fi; ( sleep "${HARNESS_CLAUDE_TERMINATE_GRACE_SECONDS:-1}"; if kill -0 "$claude_pid" 2>/dev/null; then if kill -KILL "$claude_pid" 2>/dev/null; then touch "$claude_kill_marker_path"; fi; fi ) & claude_killer_pid=$!; fi; }',
    'terminate_reader() { if kill -0 "$reader_pid" 2>/dev/null; then kill "$reader_pid" 2>/dev/null || true; ( sleep "${HARNESS_CLAUDE_TERMINATE_GRACE_SECONDS:-1}"; if kill -0 "$reader_pid" 2>/dev/null; then kill -KILL "$reader_pid" 2>/dev/null || true; fi ) & reader_killer_pid=$!; fi; }',
    `${invoke} > "$claude_stdout_pipe" 2> "$claude_stderr_path" & claude_pid=$!`,
    `HARNESS_CLAUDE_PID="$claude_pid" HARNESS_CLAUDE_STDOUT_PIPE="$claude_stdout_pipe" HARNESS_CLAUDE_READER_STATUS_PATH="$claude_reader_status_path" HARNESS_CLAUDE_READER_DIAGNOSTIC_PATH="$claude_reader_diagnostic_path" HARNESS_CLAUDE_TERM_MARKER_PATH="$claude_term_marker_path" ${nodeInlineScript(streamReaderScript)} & reader_pid=$!`,
    'while [ ! -s "$claude_reader_status_path" ]; do if ! kill -0 "$reader_pid" 2>/dev/null; then break; fi; sleep 0.05; done',
    'if [ -s "$claude_reader_status_path" ]; then reader_status="$(cat "$claude_reader_status_path")"; else reader_status=1; fi',
    'case "$reader_status" in 0|1) ;; *) reader_status=1 ;; esac',
    'if [ "$reader_status" -ne 0 ] && [ -s "$claude_reader_diagnostic_path" ]; then cat "$claude_reader_diagnostic_path"; fi',
    'if kill -0 "$reader_pid" 2>/dev/null; then terminate_reader; fi',
    'if [ -n "$reader_killer_pid" ]; then wait "$reader_killer_pid" 2>/dev/null || true; fi',
    'if [ "$reader_status" -ne 0 ] && kill -0 "$claude_pid" 2>/dev/null; then killed_for_reader_failure=1; terminate_claude; fi',
    'if [ "$reader_status" -eq 0 ] && kill -0 "$claude_pid" 2>/dev/null; then terminate_claude; fi',
    'wait "$claude_pid"',
    "claude_status=$?",
    'if [ -n "$claude_killer_pid" ]; then if [ "$claude_status" -eq 137 ]; then wait "$claude_killer_pid" 2>/dev/null || true; else kill "$claude_killer_pid" 2>/dev/null || true; wait "$claude_killer_pid" 2>/dev/null || true; fi; fi',
    'if [ "$killed_for_reader_failure" -eq 1 ]; then exit "$reader_status"; fi',
    'if [ "$reader_status" -eq 0 ]; then result_success=1; fi',
    'if [ "$result_success" -eq 1 ] && { [ "$claude_status" -eq 0 ] || { [ "$claude_status" -eq 143 ] && [ -e "$claude_term_marker_path" ]; } || { [ "$claude_status" -eq 137 ] && [ -e "$claude_kill_marker_path" ]; }; }; then exit 0; fi',
    'if [ "$reader_status" -ne 0 ] && [ "$claude_status" -eq 0 ]; then exit "$reader_status"; fi',
    'if [ "$claude_status" -ne 0 ] && [ -s "$claude_stderr_path" ]; then ' +
      'printf "\\n[claude stderr]\\n"; ' +
      'cat "$claude_stderr_path"; ' +
      "fi",
    'exit "$claude_status"',
  ].join("; ");

  return 'if [ -n "${HARNESS_CLAUDE_STREAM_PATH:-}" ]; then ' +
    `/usr/bin/bash -lc ${shellSingleQuote(streamScript)}; ` +
    'wrapper_status=$?; exit "$wrapper_status"; ' +
    "fi; " +
    `exec ${invoke}`;
}

export const CLAUDE_COMMAND = streamPersistingClaudeCommand(CLAUDE_INVOKE);
const CLAUDE_RESUME_COMMAND = streamPersistingClaudeCommand(
  CLAUDE_RESUME_INVOKE,
);

function isSafeClaudeSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.trim() === sessionId &&
    !/[\u0000-\u001f\u007f]/.test(sessionId)
  );
}

export function buildClaudeCommand(sessionId?: string): string {
  if (sessionId === undefined) return CLAUDE_COMMAND;
  if (!isSafeClaudeSessionId(sessionId)) {
    throw new Error("Unsafe Claude session id");
  }
  return CLAUDE_RESUME_COMMAND;
}

export function parseClaudeSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;

    const record = event as Record<string, unknown>;
    for (const candidate of [record.session_id, record.sessionId]) {
      if (isSafeClaudeSessionId(candidate)) return candidate;
    }
  }
  return undefined;
}

export function parseClaudeSessionIdFromCommandOutput(input: {
  stdout: string;
  stream?: string;
}): string | undefined {
  return parseClaudeSessionId(input.stdout) ??
    (input.stream ? parseClaudeSessionId(input.stream) : undefined);
}

const LOCAL_DAYTONA_NO_PROXY_HOSTS = [
  "localhost",
  "127.0.0.1",
  ".localhost",
  "proxy.localhost",
] as const;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const HTTP_EVIDENCE_MARKER = "HARNESS_HTTP_EVIDENCE ";
const HTTP_EVIDENCE_SCRIPT = `
const request = JSON.parse(process.env.HARNESS_HTTP_REQUEST);
try {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs ?? 30000),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ${MAX_EVIDENCE_BYTES}) {
        throw new Error("HTTP response body exceeded evidence limit");
      }
      chunks.push(value);
    }
  }
  const body = new TextDecoder().decode(
    chunks.length === 0
      ? new Uint8Array()
      : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
  process.stdout.write("${HTTP_EVIDENCE_MARKER}" + JSON.stringify({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`.trim();
const HTTP_EVIDENCE_SCRIPT_B64 = Buffer.from(
  HTTP_EVIDENCE_SCRIPT,
  "utf8",
).toString("base64");
const HTTP_EVIDENCE_COMMAND = [
  "set -e",
  'script="$(mktemp /tmp/harness-http-evidence.XXXXXX.mjs)"',
  'trap \'rm -f "$script"\' EXIT',
  'printf %s "$HARNESS_HTTP_SCRIPT_B64" | base64 -d > "$script"',
  'node "$script"',
].join("; ");

function parseHttpEvidenceEnvelope(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.startsWith(HTTP_EVIDENCE_MARKER)) {
      return JSON.parse(line.slice(HTTP_EVIDENCE_MARKER.length));
    }
  }
  throw new Error("HTTP evidence marker is missing");
}

export const CLAUDE_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_REASONING_MODEL",
] as const;

const REQUIRED_CLAUDE_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
] as const;

type Environment = Record<string, string | undefined>;
export type ClaudeEnvironment = Record<
  (typeof CLAUDE_ENVIRONMENT_VARIABLES)[number],
  string
>;

export interface DaytonaManager {
  createAgentSandbox(): Promise<SandboxHandle>;
  createGateSandbox(): Promise<SandboxHandle>;
}

export interface DaytonaManagerOptions {
  provider?: SandboxProvider;
  environment?: Environment;
}

export interface DaytonaSdkPty {
  waitForConnection(): Promise<void>;
  sendInput(data: string): Promise<void>;
  wait(): Promise<{ exitCode?: number; error?: string }>;
  kill(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DaytonaSdkSandbox {
  readonly id: string;
  toolboxProxyUrl?: string;
  readonly fs: {
    createFolder(path: string, mode: string): Promise<void>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
    downloadFile(path: string): Promise<Buffer>;
    getFileDetails(path: string): Promise<FileInfo>;
    listFiles(path: string): Promise<FileInfo[]>;
    setFilePermissions(
      path: string,
      permissions: { mode: string },
    ): Promise<void>;
    uploadFiles(
      files: Array<{ source: Buffer; destination: string }>,
    ): Promise<void>;
  };
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
    createPty(options: {
      id: string;
      cwd?: string;
      envs?: Record<string, string>;
      onData(data: Uint8Array): void | Promise<void>;
    }): Promise<DaytonaSdkPty>;
  };
  updateNetworkSettings(settings: {
    networkBlockAll: boolean;
  }): Promise<void>;
}

export interface DaytonaSdkClient {
  readonly volume?: DaytonaVolumeService;
  create(params: {
    language: string;
    snapshot?: string;
    labels: Record<string, string>;
    envVars: Record<string, string>;
    ephemeral: boolean;
    networkBlockAll: boolean;
    volumes?: VolumeMount[];
  }): Promise<DaytonaSdkSandbox>;
  get(sandboxIdOrName: string): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
}

export interface DaytonaVolumeService {
  get(
    name: string,
    create?: boolean,
  ): Promise<{ id: string; name: string }>;
}

type DaytonaSdkSandboxInternals = DaytonaSdkSandbox & {
  axiosInstance?: {
    defaults: {
      baseURL?: string;
    };
  };
  clientConfig?: {
    basePath?: string;
  };
};

function isLocalDaytonaApiUrl(apiUrl: string): boolean {
  const url = new URL(apiUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function shouldRewriteToolboxProxy(
  sandbox: DaytonaSdkSandbox,
  apiUrl: string,
): boolean {
  if (isLocalDaytonaApiUrl(apiUrl)) return false;
  const toolboxProxyUrl = sandbox.toolboxProxyUrl;
  if (!toolboxProxyUrl) return false;
  const parsed = new URL(toolboxProxyUrl);
  return ["proxy.localhost", "localhost", "127.0.0.1"].includes(
    parsed.hostname,
  );
}

export function rewriteRemoteToolboxProxy(
  sandbox: DaytonaSdkSandbox,
  apiUrl: string,
): void {
  if (!shouldRewriteToolboxProxy(sandbox, apiUrl)) return;
  const patchable = sandbox as DaytonaSdkSandboxInternals;
  const parsedApiUrl = new URL(apiUrl);
  const apiPath = parsedApiUrl.pathname.replace(/\/$/, "");
  parsedApiUrl.pathname = apiPath.endsWith("/api")
    ? apiPath.slice(0, -"/api".length)
    : apiPath;
  const publicBaseUrl = parsedApiUrl.toString().replace(/\/$/, "");
  const toolboxProxyUrl = `${publicBaseUrl}/toolbox`;
  const restToolboxProxyUrl = `${apiUrl.replace(/\/$/, "")}/toolbox`;
  const baseURL = `${restToolboxProxyUrl}/${sandbox.id}/toolbox`;
  sandbox.toolboxProxyUrl = toolboxProxyUrl;
  if (patchable.axiosInstance) {
    patchable.axiosInstance.defaults.baseURL = baseURL;
  }
  if (patchable.clientConfig) {
    patchable.clientConfig.basePath = baseURL;
  }
}

export function getDaytonaConfig(
  environment: Environment,
): { apiUrl: string; apiKey: string } {
  const apiKey = environment.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: DAYTONA_API_KEY");
  }
  return {
    apiUrl: environment.DAYTONA_API_URL || DEFAULT_DAYTONA_API_URL,
    apiKey,
  };
}

export function getLocalDaytonaNoProxy(currentValue = ""): string {
  const entries = currentValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([...entries, ...LOCAL_DAYTONA_NO_PROXY_HOSTS])].join(",");
}

export function configureLocalDaytonaProxy(environment: Environment): void {
  const noProxy = getLocalDaytonaNoProxy(
    [environment.NO_PROXY, environment.no_proxy].filter(Boolean).join(","),
  );
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
}

export function getClaudeEnvironment(
  environment: Environment,
): ClaudeEnvironment {
  const missing = REQUIRED_CLAUDE_ENVIRONMENT_VARIABLES.filter(
    (name) => !environment[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
  const resolvedEnvironment: Environment = {
    ...environment,
    ANTHROPIC_MODEL:
      environment.ANTHROPIC_MODEL ?? environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_REASONING_MODEL:
      environment.ANTHROPIC_REASONING_MODEL ?? environment.ANTHROPIC_DEFAULT_OPUS_MODEL,
  };
  return Object.fromEntries(
    CLAUDE_ENVIRONMENT_VARIABLES.map((name) => [name, resolvedEnvironment[name]!]),
  ) as ClaudeEnvironment;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function commandLine(command: string, args: string[]): string {
  return ["/usr/bin/env", "--", command, ...args]
    .map(quotePosix)
    .join(" ");
}

function boundedEvidence(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_EVIDENCE_BYTES) return value;
  return Buffer.concat([
    bytes.subarray(0, MAX_EVIDENCE_BYTES),
    Buffer.from("\n[HARNESS OUTPUT TRUNCATED]"),
  ]).toString("utf8");
}

function ptyCommandWrapper(command: string): string {
  return `{ ${command}; }; status=$?; exit "$status"\n`;
}

function ptyOutputTail(chunks: Buffer[], maxBytes = 8192): string {
  if (chunks.length === 0) return "";
  const output = Buffer.concat(chunks);
  const tail = output.byteLength <= maxBytes
    ? output
    : output.subarray(output.byteLength - maxBytes);
  return tail.toString("utf8");
}

function ptyDiagnosticError(message: string, chunks: Buffer[]): Error {
  const tail = ptyOutputTail(chunks);
  if (!tail) return new Error(message);
  return new Error(`${message}\nRecent PTY output:\n${tail}`);
}

function assertRemoteCwd(remoteRoot: string, cwd: string): void {
  const normalizedRoot = posix.normalize(remoteRoot);
  const normalizedCwd = posix.normalize(cwd);
  const relative = posix.relative(normalizedRoot, normalizedCwd);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    posix.isAbsolute(relative)
  ) {
    throw new Error(`Remote execution cwd escapes workspace: ${cwd}`);
  }
}

function normalizeVolumeName(volumeName: string): string {
  const trimmed = volumeName.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new Error("Daytona volumeName must not be blank or contain NUL");
  }
  return trimmed;
}

function normalizeVolumeMountPath(mountPath: string): string {
  const trimmed = mountPath.trim();
  if (
    trimmed === "" ||
    trimmed.includes("\0") ||
    !posix.isAbsolute(trimmed)
  ) {
    throw new Error("Daytona volume mountPath must be an absolute POSIX path");
  }
  const normalized = posix.normalize(trimmed);
  if (
    normalized === "/" ||
    normalized === "/workspace" ||
    normalized.startsWith("/workspace/")
  ) {
    throw new Error(
      "Daytona volume mountPath must not be root or overlap the workspace",
    );
  }
  return normalized;
}

function normalizeVolumeSubpath(subpath: string | undefined): string | undefined {
  if (subpath === undefined) return undefined;
  const trimmed = subpath.trim();
  if (
    trimmed === "" ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    posix.isAbsolute(trimmed) ||
    trimmed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Daytona volume subpath must be a relative POSIX path");
  }
  const normalized = posix.normalize(trimmed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Daytona volume subpath must not escape the volume");
  }
  return normalized;
}

function assertSafeSandboxId(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("sandbox id must be a non-empty safe path segment");
  }
  return value;
}

function fileKind(info: FileInfo): RemoteFileEntry["kind"] {
  const mode = info.mode.toLowerCase();
  if (/^l[rwxst-]{9}$/i.test(mode) && !info.isDir) return "symlink";
  if (/^d[rwxst-]{9}$/i.test(mode) && info.isDir) return "directory";
  if (/^-[rwxst-]{9}$/i.test(mode) && !info.isDir) return "file";
  return "special";
}

function isExecutable(info: FileInfo): boolean {
  if (/[xsStT]/.test(info.mode) || /[xsStT]/.test(info.permissions)) {
    return true;
  }
  return /^[0-7]{3,4}$/.test(info.permissions)
    ? (Number.parseInt(info.permissions, 8) & 0o111) !== 0
    : false;
}

function remoteChildPath(parent: string, name: string): string {
  return name.startsWith("/") ? posix.normalize(name) : posix.join(parent, name);
}

function daytonaSdkPath(path: string): string {
  const normalized = posix.normalize(path);
  const relative = posix.isAbsolute(normalized)
    ? normalized.slice(1)
    : normalized;
  if (!relative) {
    throw new Error(`Daytona SDK path must not be the filesystem root: ${path}`);
  }
  return relative;
}

function relativeRemotePath(root: string, path: string): string {
  const relative = posix.relative(root, path);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    posix.isAbsolute(relative)
  ) {
    throw new Error(`Daytona returned a path outside the workspace: ${path}`);
  }
  return relative;
}

class DaytonaRemoteWorkspace implements RemoteWorkspace {
  private readonly listed = new Map<string, RemoteFileEntry>();

  constructor(
    private readonly sandbox: DaytonaSdkSandbox,
    private readonly remoteRoot: string,
    private readonly maxEntries: number,
    private readonly watchedRoots?: string[],
  ) {}

  async list(root: string): Promise<RemoteFileEntry[]> {
    if (posix.normalize(root) !== this.remoteRoot) {
      throw new Error(`Unexpected remote workspace root: ${root}`);
    }
    const entries: RemoteFileEntry[] = [];
    await this.walk(this.remoteRoot, entries);
    return entries;
  }

  async read(path: string): Promise<Buffer> {
    const normalized = normalizeWorkspacePath(path);
    const expected = this.listed.get(normalized);
    if (!expected || expected.kind !== "file") {
      throw new Error(`Remote file was not listed as regular: ${path}`);
    }
    const destination = posix.join(this.remoteRoot, normalized);
    const sdkDestination = daytonaSdkPath(destination);
    const before = await this.sandbox.fs.getFileDetails(sdkDestination);
    if (
      fileKind(before) !== "file" ||
      before.size !== expected.size ||
      isExecutable(before) !== expected.executable
    ) {
      throw new Error(`Remote file changed before download: ${path}`);
    }
    const content = await this.sandbox.fs.downloadFile(sdkDestination);
    const after = await this.sandbox.fs.getFileDetails(sdkDestination);
    if (
      fileKind(after) !== "file" ||
      after.size !== before.size ||
      isExecutable(after) !== isExecutable(before)
    ) {
      throw new Error(`Remote file changed during download: ${path}`);
    }
    return content;
  }

  private async walk(
    directory: string,
    entries: RemoteFileEntry[],
  ): Promise<void> {
    const listed = await this.sandbox.fs.listFiles(daytonaSdkPath(directory));
    for (const info of listed) {
      const destination = remoteChildPath(directory, info.name);
      const path = relativeRemotePath(this.remoteRoot, destination);
      const kind = fileKind(info);
      const entry: RemoteFileEntry = {
        path,
        kind,
        size: info.size,
        executable: kind === "file" && isExecutable(info),
      };
      entries.push(entry);
      this.listed.set(path, entry);
      if (entries.length > this.maxEntries) {
        throw new Error(`Remote workspace exceeds ${this.maxEntries} entries`);
      }
      if (
        kind === "directory" &&
        this.shouldTraverse(path)
      ) {
        await this.walk(destination, entries);
      }
    }
  }

  private shouldTraverse(path: string): boolean {
    if (!this.watchedRoots) return true;
    const pathKey = protectedFilesystemPathKey(path);
    return this.watchedRoots.some((root) => {
      const rootKey = protectedFilesystemPathKey(root);
      return (
        path === root ||
        path.startsWith(`${root}/`) ||
        root.startsWith(`${path}/`) ||
        pathKey === rootKey ||
        pathKey.startsWith(`${rootKey}/`) ||
        rootKey.startsWith(`${pathKey}/`)
      );
    });
  }
}

class DaytonaSandboxHandle implements SandboxHandle {
  readonly id: string;

  constructor(
    private readonly client: DaytonaSdkClient,
    private readonly sandbox: DaytonaSdkSandbox,
  ) {
    this.id = sandbox.id;
  }

  async upload(files: WorkspaceFile[], remoteRoot: string): Promise<void> {
    const root = posix.normalize(remoteRoot);
    await this.sandbox.fs.createFolder(daytonaSdkPath(root), "755");
    const directories = new Set<string>();
    for (const file of files) {
      const path = normalizeWorkspacePath(file.path);
      const destination = posix.join(root, path);
      if (relativeRemotePath(root, destination) !== path) {
        throw new Error(`Upload path escapes remote workspace: ${file.path}`);
      }
      let directory = posix.dirname(destination);
      while (directory !== root && directory.startsWith(`${root}/`)) {
        directories.add(directory);
        directory = posix.dirname(directory);
      }
    }
    for (const directory of [...directories].sort()) {
      await this.sandbox.fs.createFolder(daytonaSdkPath(directory), "755");
    }
    if (files.length > 0) {
      await this.sandbox.fs.uploadFiles(
        files.map((file) => ({
          source: Buffer.from(file.content),
          destination: daytonaSdkPath(
            posix.join(root, normalizeWorkspacePath(file.path)),
          ),
        })),
      );
    }
    for (const file of files) {
      await this.sandbox.fs.setFilePermissions(
        daytonaSdkPath(
          posix.join(root, normalizeWorkspacePath(file.path)),
        ),
        { mode: file.executable ? "755" : "644" },
      );
    }
  }

  async remove(paths: string[], remoteRoot: string): Promise<void> {
    const root = posix.normalize(remoteRoot);
    for (const rawPath of paths) {
      const path = normalizeWorkspacePath(rawPath);
      const destination = posix.join(root, path);
      if (relativeRemotePath(root, destination) !== path) {
        throw new Error(`Removal path escapes remote workspace: ${rawPath}`);
      }
      await this.sandbox.fs.deleteFile(daytonaSdkPath(destination), false);
    }
  }

  async verify(files: WorkspaceFile[], remoteRoot: string): Promise<void> {
    const root = posix.normalize(remoteRoot);
    for (const file of files) {
      const path = normalizeWorkspacePath(file.path);
      const destination = posix.join(root, path);
      if (relativeRemotePath(root, destination) !== path) {
        throw new Error(`Verification path escapes remote workspace: ${path}`);
      }
      const sdkDestination = daytonaSdkPath(destination);
      const details = await this.sandbox.fs.getFileDetails(sdkDestination);
      if (
        fileKind(details) !== "file" ||
        details.size !== file.content.byteLength ||
        isExecutable(details) !== file.executable
      ) {
        throw new Error(`Host-controlled file metadata changed: ${path}`);
      }
      const content = await this.sandbox.fs.downloadFile(sdkDestination);
      const hash = createHash("sha256").update(content).digest("hex");
      if (hash !== file.sha256 || !content.equals(file.content)) {
        throw new Error(`Host-controlled file bytes changed: ${path}`);
      }
    }
  }

  workspace(
    remoteRoot: string,
    maxEntries = 10_000,
    watchedRoots?: string[],
  ): RemoteWorkspace {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    return new DaytonaRemoteWorkspace(
      this.sandbox,
      posix.normalize(remoteRoot),
      maxEntries,
      watchedRoots?.map(normalizeWorkspacePath),
    );
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SandboxCommandResult> {
    const timeoutSeconds = timeoutMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(timeoutMs / 1000));
    const result = await this.sandbox.process.executeCommand(
      command,
      daytonaSdkPath(cwd),
      env,
      timeoutSeconds,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.result,
      stderr: "",
    };
  }

  async readFile(path: string): Promise<Buffer> {
    if (posix.isAbsolute(path)) {
      try {
        return await this.sandbox.fs.downloadFile(path);
      } catch {
        // Older workspace paths were passed through the SDK without a leading
        // slash. Keep that fallback while allowing absolute volume mounts.
      }
    }
    return await this.sandbox.fs.downloadFile(daytonaSdkPath(path));
  }

  async runPty(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs = 30 * 60 * 1000,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    const maxOutputBytes = 16 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | undefined;
    let pty: DaytonaSdkPty | undefined;
    let rejectInterruption: (error: Error) => void = () => undefined;
    let killStarted: Promise<void> | undefined;
    let disconnectStarted: Promise<void> | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const safeKill = () => {
      if (!pty) return Promise.resolve();
      killStarted ??= pty.kill().catch(() => undefined);
      return killStarted;
    };
    const safeDisconnect = () => {
      if (!pty) return Promise.resolve();
      disconnectStarted ??= pty.disconnect().catch(() => undefined);
      return disconnectStarted;
    };
    const cleanupInterruptedPty = async () => {
      await safeKill();
      await safeDisconnect();
    };
    const interrupt = (error: Error) => {
      if (terminalError) return;
      terminalError = error;
      rejectInterruption(error);
      void cleanupInterruptedPty();
    };
    if (signal?.aborted) {
      throw signal.reason ?? new Error("PTY execution aborted");
    }
    pty = await this.sandbox.process.createPty({
      id: `harness-${randomUUID()}`,
      cwd: daytonaSdkPath(cwd),
      envs: env,
      async onData(data) {
        if (terminalError) return;
        const chunk = Buffer.from(data);
        outputBytes += chunk.byteLength;
        chunks.push(chunk);
        if (outputBytes > maxOutputBytes) {
          interrupt(ptyDiagnosticError(
            `PTY output exceeded ${maxOutputBytes} bytes`,
            chunks,
          ));
          return;
        }
      },
    });
    const timer = setTimeout(() => {
      interrupt(ptyDiagnosticError(
        `PTY timed out after ${timeoutMs}ms`,
        chunks,
      ));
    }, timeoutMs);
    timer.unref();
    const abort = () => {
      interrupt(signal?.reason instanceof Error
        ? signal.reason
        : new Error("PTY execution aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([pty.waitForConnection(), interruption]);
      await Promise.race([
        pty.sendInput(ptyCommandWrapper(command)),
        interruption,
      ]);
      const result = await Promise.race([pty.wait(), interruption]);
      if (terminalError) throw terminalError;
      return {
        exitCode: result.exitCode ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: result.error ?? "",
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (terminalError) {
        await cleanupInterruptedPty();
      } else {
        await safeDisconnect();
      }
    }
  }

  async setNetworkBlocked(blocked: boolean): Promise<void> {
    await this.sandbox.updateNetworkSettings({ networkBlockAll: blocked });
  }

  async delete(): Promise<void> {
    await this.client.delete(this.sandbox);
  }
}

function commandErrorEvidence(
  executionId: string,
  startedAt: number,
  error: unknown,
): CommandExecutionEvidence {
  return {
    executionId,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: performance.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

function httpErrorEvidence(
  executionId: string,
  startedAt: number,
  error: unknown,
): HttpExecutionEvidence {
  return {
    executionId,
    headers: {},
    body: "",
    durationMs: performance.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createDaytonaExecutionTarget(
  handle: SandboxHandle,
  remoteRoot: string,
): ExecutionTarget {
  return {
    async execute(request) {
      const startedAt = performance.now();
      try {
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new Error("Execution aborted");
        }
        assertRemoteCwd(remoteRoot, request.cwd);
        const env = Object.fromEntries(
          Object.entries(request.env ?? {})
            .filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            ),
        );
        const result = await handle.execute(
          commandLine(request.command, request.args),
          request.cwd,
          env,
          request.timeoutMs,
        );
        return {
          executionId: request.executionId,
          exitCode: result.exitCode,
          stdout: boundedEvidence(result.stdout),
          stderr: boundedEvidence(result.stderr),
          durationMs: performance.now() - startedAt,
        };
      } catch (error) {
        return commandErrorEvidence(request.executionId, startedAt, error);
      }
    },

    async request(request) {
      const startedAt = performance.now();
      try {
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new Error("Execution aborted");
        }
        const result = await handle.execute(
          HTTP_EVIDENCE_COMMAND,
          remoteRoot,
          {
            HARNESS_HTTP_SCRIPT_B64: HTTP_EVIDENCE_SCRIPT_B64,
            HARNESS_HTTP_REQUEST: JSON.stringify({
              url: request.url,
              method: request.method,
              headers: request.headers,
              body: request.body,
              timeoutMs: request.timeoutMs,
            }),
          },
          request.timeoutMs,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            boundedEvidence(result.stderr || result.stdout) ||
            `HTTP evidence process exited ${result.exitCode}`,
          );
        }
        const parsed = parseHttpEvidenceEnvelope(result.stdout);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("status" in parsed) ||
          typeof parsed.status !== "number" ||
          !("headers" in parsed) ||
          typeof parsed.headers !== "object" ||
          parsed.headers === null ||
          Array.isArray(parsed.headers) ||
          !("body" in parsed) ||
          typeof parsed.body !== "string"
        ) {
          throw new Error("HTTP evidence envelope is malformed");
        }
        const headers = Object.fromEntries(
          Object.entries(parsed.headers)
            .filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            ),
        );
        return {
          executionId: request.executionId,
          status: parsed.status,
          headers,
          body: boundedEvidence(parsed.body),
          durationMs: performance.now() - startedAt,
        };
      } catch (error) {
        return httpErrorEvidence(request.executionId, startedAt, error);
      }
    },
  };
}

class DaytonaSdkProvider implements SandboxProvider {
  constructor(
    private readonly client: DaytonaSdkClient,
    private readonly apiUrl?: string,
  ) {}

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    const snapshot = request.snapshot?.trim();
    if (
      request.snapshot !== undefined &&
      !snapshot
    ) {
      const role = request.role === "agent" ? "Agent" : "Gate";
      throw new Error(`${role} snapshot must not be empty`);
    }
    const volumes = await this.resolveVolumes(request);
    const sandbox = await this.client.create({
      language: "typescript",
      ...(snapshot ? { snapshot } : {}),
      labels: { "harness.role": request.role },
      envVars: request.envVars,
      ephemeral: request.ephemeral,
      networkBlockAll: false,
      ...(volumes.length > 0 ? { volumes } : {}),
    });
    if (this.apiUrl) rewriteRemoteToolboxProxy(sandbox, this.apiUrl);
    return new DaytonaSandboxHandle(this.client, sandbox);
  }

  async attach(sandboxId: string): Promise<SandboxHandle> {
    const sandbox = await this.client.get(assertSafeSandboxId(sandboxId));
    if (this.apiUrl) rewriteRemoteToolboxProxy(sandbox, this.apiUrl);
    return new DaytonaSandboxHandle(this.client, sandbox);
  }

  private async resolveVolumes(
    request: SandboxCreateRequest,
  ): Promise<VolumeMount[]> {
    const requested = request.volumes ?? [];
    if (requested.length === 0) return [];
    const validated = requested.map((mount) => {
      const subpath = normalizeVolumeSubpath(mount.subpath);
      return {
        volumeName: normalizeVolumeName(mount.volumeName),
        mountPath: normalizeVolumeMountPath(mount.mountPath),
        ...(subpath ? { subpath } : {}),
      };
    });
    const service = this.client.volume;
    if (!service) {
      throw new Error("Daytona volume service is required for volume mounts");
    }
    return Promise.all(
      validated.map(async (mount) => {
        const volume = await service.get(mount.volumeName, true);
        return {
          volumeId: volume.id,
          mountPath: mount.mountPath,
          ...(mount.subpath ? { subpath: mount.subpath } : {}),
        };
      }),
    );
  }
}

export function createDaytonaSdkProvider(
  environment: Environment = process.env,
): SandboxProvider {
  configureLocalDaytonaProxy(environment);
  const config = getDaytonaConfig(environment);
  return createDaytonaSdkProviderFromClient(
    new Daytona(config),
    config.apiUrl,
  );
}

export function createDaytonaSdkProviderFromClient(
  client: DaytonaSdkClient,
  apiUrl?: string,
): SandboxProvider & { attach(sandboxId: string): Promise<SandboxHandle> } {
  return new DaytonaSdkProvider(client, apiUrl);
}

export function createDaytonaManager(
  options: DaytonaManagerOptions = {},
): DaytonaManager {
  const environment = options.environment ?? process.env;
  getDaytonaConfig(environment);
  const agentSnapshot = requireAgentSnapshot(environment);
  const gateSnapshot = getGateSnapshot(environment);
  configureLocalDaytonaProxy(environment);
  const provider = options.provider ?? createDaytonaSdkProvider(environment);
  return {
    createAgentSandbox() {
      return provider.create({
        role: "agent",
        snapshot: agentSnapshot,
        envVars: {},
        ephemeral: false,
      });
    },
    createGateSandbox() {
      return provider.create({
        role: "gate",
        snapshot: gateSnapshot,
        envVars: {},
        ephemeral: true,
      });
    },
  };
}

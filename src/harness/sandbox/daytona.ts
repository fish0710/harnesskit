import { Daytona, type FileInfo } from "@daytona/sdk";
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

export const DEFAULT_DAYTONA_API_URL = "http://localhost:3000/api";
export const CLAUDE_INSTALL_COMMAND =
  'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code';
export const CLAUDE_COMMAND =
  'exec "$HOME/.local/bin/claude" --dangerously-skip-permissions ' +
  '-p "$HARNESS_PROMPT" --output-format stream-json --verbose';

const LOCAL_DAYTONA_NO_PROXY_HOSTS = [
  "localhost",
  "127.0.0.1",
  ".localhost",
  "proxy.localhost",
] as const;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
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
  process.stdout.write(JSON.stringify({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`.trim();

export const CLAUDE_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_REASONING_MODEL",
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
  create(params: {
    language: string;
    labels: Record<string, string>;
    envVars: Record<string, string>;
    ephemeral: boolean;
    networkBlockAll: boolean;
  }): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
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
  const missing = CLAUDE_ENVIRONMENT_VARIABLES.filter(
    (name) => !environment[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
  return Object.fromEntries(
    CLAUDE_ENVIRONMENT_VARIABLES.map((name) => [name, environment[name]!]),
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
    const before = await this.sandbox.fs.getFileDetails(destination);
    if (
      fileKind(before) !== "file" ||
      before.size !== expected.size ||
      isExecutable(before) !== expected.executable
    ) {
      throw new Error(`Remote file changed before download: ${path}`);
    }
    const content = await this.sandbox.fs.downloadFile(destination);
    const after = await this.sandbox.fs.getFileDetails(destination);
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
    const listed = await this.sandbox.fs.listFiles(directory);
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
    await this.sandbox.fs.createFolder(root, "755");
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
      await this.sandbox.fs.createFolder(directory, "755");
    }
    await this.sandbox.fs.uploadFiles(
      files.map((file) => ({
        source: Buffer.from(file.content),
        destination: posix.join(root, normalizeWorkspacePath(file.path)),
      })),
    );
    for (const file of files) {
      await this.sandbox.fs.setFilePermissions(
        posix.join(root, normalizeWorkspacePath(file.path)),
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
      await this.sandbox.fs.deleteFile(destination, false);
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
      const details = await this.sandbox.fs.getFileDetails(destination);
      if (
        fileKind(details) !== "file" ||
        details.size !== file.content.byteLength ||
        isExecutable(details) !== file.executable
      ) {
        throw new Error(`Host-controlled file metadata changed: ${path}`);
      }
      const content = await this.sandbox.fs.downloadFile(destination);
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
      cwd,
      env,
      timeoutSeconds,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.result,
      stderr: "",
    };
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
    if (signal?.aborted) {
      throw signal.reason ?? new Error("PTY execution aborted");
    }
    pty = await this.sandbox.process.createPty({
      id: `harness-${randomUUID()}`,
      cwd,
      envs: env,
      async onData(data) {
        if (terminalError) return;
        const chunk = Buffer.from(data);
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          terminalError = new Error(
            `PTY output exceeded ${maxOutputBytes} bytes`,
          );
          await pty?.kill();
          return;
        }
        chunks.push(chunk);
      },
    });
    const timer = setTimeout(() => {
      terminalError = new Error(`PTY timed out after ${timeoutMs}ms`);
      void pty?.kill();
    }, timeoutMs);
    timer.unref();
    const abort = () => {
      terminalError = signal?.reason instanceof Error
        ? signal.reason
        : new Error("PTY execution aborted");
      void pty?.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await pty.waitForConnection();
      const executable = command.startsWith("exec ") ? command : `exec ${command}`;
      await pty.sendInput(`${executable}\n`);
      const result = await pty.wait();
      if (terminalError) throw terminalError;
      return {
        exitCode: result.exitCode ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: result.error ?? "",
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await pty.disconnect();
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
        const result = await handle.runPty(
          commandLine(request.command, request.args),
          request.cwd,
          env,
          request.timeoutMs,
          request.signal,
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
          commandLine("node", ["-e", HTTP_EVIDENCE_SCRIPT]),
          remoteRoot,
          {
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
        const parsed: unknown = JSON.parse(result.stdout);
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
  constructor(private readonly client: DaytonaSdkClient) {}

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    const sandbox = await this.client.create({
      language: "typescript",
      labels: { "harness.role": request.role },
      envVars: request.envVars,
      ephemeral: request.ephemeral,
      networkBlockAll: false,
    });
    return new DaytonaSandboxHandle(this.client, sandbox);
  }
}

export function createDaytonaSdkProvider(
  environment: Environment = process.env,
): SandboxProvider {
  configureLocalDaytonaProxy(environment);
  return createDaytonaSdkProviderFromClient(
    new Daytona(getDaytonaConfig(environment)),
  );
}

export function createDaytonaSdkProviderFromClient(
  client: DaytonaSdkClient,
): SandboxProvider {
  return new DaytonaSdkProvider(client);
}

export function createDaytonaManager(
  options: DaytonaManagerOptions = {},
): DaytonaManager {
  const environment = options.environment ?? process.env;
  getDaytonaConfig(environment);
  configureLocalDaytonaProxy(environment);
  const provider = options.provider ?? createDaytonaSdkProvider(environment);
  return {
    createAgentSandbox() {
      return provider.create({
        role: "agent",
        envVars: {},
        ephemeral: false,
      });
    },
    createGateSandbox() {
      return provider.create({
        role: "gate",
        envVars: {},
        ephemeral: true,
      });
    },
  };
}

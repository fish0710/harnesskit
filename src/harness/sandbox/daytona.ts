import { Daytona, type FileInfo } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import type {
  RemoteFileEntry,
  RemoteWorkspace,
} from "./workspace.js";
import { normalizeWorkspacePath } from "./policy.js";
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
      if (kind === "directory") await this.walk(destination, entries);
    }
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

  workspace(remoteRoot: string, maxEntries = 10_000): RemoteWorkspace {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    return new DaytonaRemoteWorkspace(
      this.sandbox,
      posix.normalize(remoteRoot),
      maxEntries,
    );
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<SandboxCommandResult> {
    const result = await this.sandbox.process.executeCommand(command, cwd, env);
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
  ): Promise<SandboxCommandResult> {
    const maxOutputBytes = 16 * 1024 * 1024;
    const timeoutMs = 30 * 60 * 1000;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | undefined;
    let pty: DaytonaSdkPty | undefined;
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

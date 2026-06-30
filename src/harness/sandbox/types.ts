import type { RemoteWorkspace } from "./workspace.js";

export interface SandboxLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface SandboxPolicy {
  candidateRoots: string[];
  protectedPaths: string[];
  readOnlyPaths: string[];
  agentSetup: string[];
  gateSetup: string[];
  limits: SandboxLimits;
  retainOnFailure: boolean;
}

export interface WorkspaceFile {
  path: string;
  content: Buffer;
  executable: boolean;
  sha256: string;
}

export interface WorkspaceSnapshot {
  root: string;
  files: Map<string, WorkspaceFile>;
}

export type CandidateOperation =
  | { kind: "add"; file: WorkspaceFile }
  | { kind: "modify"; before: WorkspaceFile; file: WorkspaceFile }
  | { kind: "delete"; before: WorkspaceFile };

export interface CandidateSnapshot {
  operations: CandidateOperation[];
  files: Map<string, WorkspaceFile>;
}

interface SandboxCreateBaseRequest {
  envVars: Record<string, string>;
  ephemeral: boolean;
  volumes?: SandboxVolumeMount[];
}

export interface SandboxVolumeMount {
  volumeName: string;
  mountPath: string;
  subpath?: string;
}

export type SandboxCreateRequest =
  | (SandboxCreateBaseRequest & {
    role: "agent";
    snapshot?: string;
  })
  | (SandboxCreateBaseRequest & {
    role: "gate";
    snapshot?: string;
  });

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  readonly id: string;
  upload(files: WorkspaceFile[], remoteRoot: string): Promise<void>;
  remove(paths: string[], remoteRoot: string): Promise<void>;
  verify(files: WorkspaceFile[], remoteRoot: string): Promise<void>;
  workspace(
    remoteRoot: string,
    maxEntries?: number,
    watchedRoots?: string[],
  ): RemoteWorkspace;
  execute(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<SandboxCommandResult>;
  readFile(path: string): Promise<Buffer>;
  runPty(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult>;
  setNetworkBlocked(blocked: boolean): Promise<void>;
  delete(): Promise<void>;
}

export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  attach?(sandboxId: string): Promise<SandboxHandle>;
}

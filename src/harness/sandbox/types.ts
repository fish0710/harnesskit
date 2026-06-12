export interface SandboxLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface SandboxPolicy {
  candidateRoots: string[];
  protectedPaths: string[];
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

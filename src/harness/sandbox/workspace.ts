import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  normalizeWorkspacePath,
  protectedFilesystemPathKey,
  validateCandidatePath,
} from "./policy.js";
import type {
  CandidateOperation,
  CandidateSnapshot,
  SandboxPolicy,
  WorkspaceFile,
  WorkspaceSnapshot,
} from "./types.js";

export interface RemoteFileEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "special";
  size: number;
  executable: boolean;
}

export interface RemoteWorkspace {
  list(root: string): Promise<RemoteFileEntry[]>;
  read(path: string): Promise<Buffer>;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function enforceFileLimit(
  path: string,
  size: number,
  fileCount: number,
  totalBytes: number,
  policy: SandboxPolicy,
  label: string,
): number {
  if (fileCount > policy.limits.maxFiles) {
    throw new Error(`${label}文件数量超过限制`);
  }
  if (size > policy.limits.maxFileBytes) {
    throw new Error(`${label}文件超过大小限制: ${path}`);
  }
  if (size > policy.limits.maxTotalBytes - totalBytes) {
    throw new Error(`${label}文件总大小超过限制`);
  }
  return totalBytes + size;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function assertPathInsideRoot(
  root: string,
  destination: string,
  path: string,
): void {
  const rel = relative(root, destination);
  if (
    rel === "" ||
    rel.startsWith("../") ||
    rel === ".." ||
    resolve(root, rel) !== destination
  ) {
    throw new Error(`工作区路径越界: ${path}`);
  }
}

function assertSafeHostPath(
  workspaceRoot: string,
  realWorkspaceRoot: string,
  path: string,
): void {
  const destination = join(workspaceRoot, path);
  assertPathInsideRoot(workspaceRoot, destination, path);

  let current = workspaceRoot;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`工作区父路径包含符号链接: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`工作区父路径不是目录: ${path}`);
    }
  }

  const realParent = realpathSync(dirname(destination));
  const parentRelative = relative(realWorkspaceRoot, realParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith("../") ||
    resolve(realWorkspaceRoot, parentRelative) !== realParent
  ) {
    throw new Error(`工作区文件位于工作区外: ${path}`);
  }
}

export function workspaceFile(
  path: string,
  content: Buffer,
  executable: boolean,
): WorkspaceFile {
  const ownedContent = Buffer.from(content);
  return {
    path,
    content: ownedContent,
    executable,
    sha256: createHash("sha256").update(ownedContent).digest("hex"),
  };
}

export function captureWorkspace(
  root: string,
  policy: SandboxPolicy,
): WorkspaceSnapshot {
  const workspaceRoot = resolve(root);
  let insideWorkTree: string;
  try {
    insideWorkTree = execFileSync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error(`工作区不是 Git 工作树: ${root}`);
  }
  if (insideWorkTree !== "true") {
    throw new Error(`工作区不是 Git 工作树: ${root}`);
  }
  let gitRoot: string;
  try {
    gitRoot = execFileSync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error(`无法确定 Git 工作树根目录: ${root}`);
  }
  if (realpathSync(workspaceRoot) !== realpathSync(gitRoot)) {
    throw new Error(`captureWorkspace 必须使用 Git 工作树根目录: ${root}`);
  }
  const realWorkspaceRoot = realpathSync(workspaceRoot);

  let listed: Buffer;
  try {
    listed = execFileSync(
      "git",
      [
        "-C",
        workspaceRoot,
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
      ],
      { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(`无法枚举 Git 工作树: ${root}`);
  }

  let decodedPaths: string;
  try {
    decodedPaths = new TextDecoder("utf-8", { fatal: true }).decode(listed);
  } catch {
    throw new Error("Git 工作区包含无效 UTF-8 路径编码");
  }
  const rawPaths = decodedPaths
    .split("\0")
    .filter((path) => path.length > 0);
  const files = new Map<string, WorkspaceFile>();
  const pathKeys = new Set<string>();
  let totalBytes = 0;

  for (const rawPath of rawPaths) {
    const path = normalizeWorkspacePath(rawPath);
    const pathKey = protectedFilesystemPathKey(path);
    if (files.has(path) || pathKeys.has(pathKey)) {
      throw new Error(`工作区包含重复或别名路径: ${path}`);
    }

    const destination = join(workspaceRoot, path);
    let stat;
    try {
      stat = lstatSync(destination);
    } catch (error) {
      if (isMissingFile(error)) {
        continue;
      }
      throw error;
    }
    assertSafeHostPath(workspaceRoot, realWorkspaceRoot, path);
    if (stat.isSymbolicLink()) {
      throw new Error(`工作区包含符号链接: ${path}`);
    }
    if (!stat.isFile()) {
      throw new Error(`工作区包含不支持的文件类型: ${path}`);
    }

    const nextCount = files.size + 1;
    totalBytes = enforceFileLimit(
      path,
      stat.size,
      nextCount,
      totalBytes,
      policy,
      "工作区",
    );
    const content = readFileSync(destination);
    if (content.byteLength !== stat.size) {
      throw new Error(`工作区文件读取大小不一致: ${path}`);
    }
    files.set(
      path,
      workspaceFile(path, content, (stat.mode & 0o111) !== 0),
    );
    pathKeys.add(pathKey);
  }

  return { root, files };
}

export function agentVisibleFiles(
  snapshot: WorkspaceSnapshot,
  policy: SandboxPolicy,
): WorkspaceFile[] {
  return [...snapshot.files.values()]
    .filter((file) => {
      try {
        validateCandidatePath(file.path, policy);
        return true;
      } catch {
        return false;
      }
    })
    .sort((left, right) => comparePaths(left.path, right.path));
}

export function deriveCandidateOperations(
  baseline: WorkspaceSnapshot,
  files: Map<string, WorkspaceFile>,
  policy: SandboxPolicy,
): CandidateOperation[] {
  const baselineFiles = new Map(
    agentVisibleFiles(baseline, policy).map((file) => [file.path, file]),
  );
  const paths = new Set([...baselineFiles.keys(), ...files.keys()]);
  const operations: CandidateOperation[] = [];

  for (const path of [...paths].sort(comparePaths)) {
    const before = baselineFiles.get(path);
    const file = files.get(path);
    if (!before && file) {
      operations.push({ kind: "add", file });
    } else if (before && !file) {
      operations.push({ kind: "delete", before });
    } else if (
      before &&
      file &&
      (before.sha256 !== file.sha256 ||
        before.executable !== file.executable ||
        !before.content.equals(file.content))
    ) {
      operations.push({ kind: "modify", before, file });
    }
  }
  return operations;
}

function validateRemoteMetadata(entry: RemoteFileEntry): void {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`候选文件大小必须是非负安全整数: ${entry.path}`);
  }
  if (typeof entry.executable !== "boolean") {
    throw new Error(`候选文件 executable 必须是布尔值: ${entry.path}`);
  }
}

export async function collectCandidate(
  remote: RemoteWorkspace,
  baseline: WorkspaceSnapshot,
  policy: SandboxPolicy,
): Promise<CandidateSnapshot> {
  const entries = await remote.list("/workspace/candidate");
  if (!Array.isArray(entries)) {
    throw new Error("候选文件列表格式无效");
  }

  const files = new Map<string, WorkspaceFile>();
  const pathKeys = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("候选文件条目格式无效");
    }
    const path = validateCandidatePath(entry.path, policy);
    validateRemoteMetadata(entry);

    const pathKey = protectedFilesystemPathKey(path);
    if (files.has(path) || pathKeys.has(pathKey)) {
      throw new Error(`候选包含重复或别名路径: ${path}`);
    }
    pathKeys.add(pathKey);

    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`候选包含不支持的文件类型: ${path} (${entry.kind})`);
    }

    const nextCount = files.size + 1;
    totalBytes = enforceFileLimit(
      path,
      entry.size,
      nextCount,
      totalBytes,
      policy,
      "候选",
    );
    const content = await remote.read(path);
    if (!Buffer.isBuffer(content)) {
      throw new Error(`候选文件读取结果不是 Buffer: ${path}`);
    }
    if (content.byteLength !== entry.size) {
      throw new Error(`候选文件读取大小不一致: ${path}`);
    }
    files.set(path, workspaceFile(path, content, entry.executable));
  }

  const operations = deriveCandidateOperations(baseline, files, policy);
  return { operations, files };
}

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import {
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

export interface PublicationResult {
  ok: boolean;
  changedFiles: string[];
  conflict?: string;
}

interface PreparedOperation {
  operation: CandidateOperation;
  path: string;
  destination: string;
}

interface StagedWrite {
  temporary: string;
  destination: string;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateWorkspaceFile(
  value: unknown,
  label: string,
  policy: SandboxPolicy,
): WorkspaceFile {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["path", "content", "executable", "sha256"],
  )) {
    throw new Error(`${label}文件记录格式无效`);
  }
  if (typeof value.path !== "string") {
    throw new Error(`${label}文件路径格式无效`);
  }
  const path = validateCandidatePath(value.path, policy);
  if (!Buffer.isBuffer(value.content)) {
    throw new Error(`${label}文件内容格式无效: ${path}`);
  }
  if (typeof value.executable !== "boolean") {
    throw new Error(`${label}文件可执行标记格式无效: ${path}`);
  }
  if (
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    sha256(value.content) !== value.sha256
  ) {
    throw new Error(`${label}文件哈希无效: ${path}`);
  }
  return value as unknown as WorkspaceFile;
}

function workspaceFilesEqual(
  left: WorkspaceFile,
  right: WorkspaceFile,
): boolean {
  return (
    left.path === right.path &&
    left.executable === right.executable &&
    left.sha256 === right.sha256 &&
    left.content.equals(right.content)
  );
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertSafeParents(root: string, path: string): void {
  const rootStat = lstatIfPresent(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`工作区根目录类型冲突: ${root}`);
  }

  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`父路径包含符号链接: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`父路径不是目录: ${path}`);
    }
  }
}

function assertCurrentMatches(
  destination: string,
  before: WorkspaceFile,
): void {
  const stat = lstatIfPresent(destination);
  if (!stat) {
    throw new Error(`主机文件已不存在: ${before.path}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`主机文件变为符号链接: ${before.path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`主机文件类型发生变化: ${before.path}`);
  }
  const content = readFileSync(destination);
  if (
    sha256(content) !== before.sha256 ||
    !content.equals(before.content) ||
    ((stat.mode & 0o111) !== 0) !== before.executable
  ) {
    throw new Error(`主机文件已发生并发变化: ${before.path}`);
  }
}

function prepareOperations(
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): PreparedOperation[] {
  if (!isRecord(candidate) || !Array.isArray(candidate.operations)) {
    throw new Error("候选操作列表格式无效");
  }

  const prepared: PreparedOperation[] = [];
  const pathKeys = new Set<string>();

  for (const value of candidate.operations as unknown[]) {
    if (!isRecord(value) || typeof value.kind !== "string") {
      throw new Error("候选操作格式无效");
    }

    let operation: CandidateOperation;
    let path: string;
    if (value.kind === "add") {
      if (!hasExactKeys(value, ["kind", "file"])) {
        throw new Error("add 候选操作格式无效");
      }
      const file = validateWorkspaceFile(value.file, "新增", policy);
      path = file.path;
      if (baseline.files.has(path)) {
        throw new Error(`新增操作与基线冲突: ${path}`);
      }
      operation = { kind: "add", file };
    } else if (value.kind === "modify") {
      if (!hasExactKeys(value, ["kind", "before", "file"])) {
        throw new Error("modify 候选操作格式无效");
      }
      const before = validateWorkspaceFile(value.before, "修改前", policy);
      const file = validateWorkspaceFile(value.file, "修改后", policy);
      if (before.path !== file.path) {
        throw new Error(`修改操作路径不一致: ${before.path}`);
      }
      const baselineFile = baseline.files.get(before.path);
      if (
        !baselineFile ||
        !workspaceFilesEqual(
          validateWorkspaceFile(baselineFile, "基线", policy),
          before,
        )
      ) {
        throw new Error(`修改操作 before 与基线不一致: ${before.path}`);
      }
      path = file.path;
      operation = { kind: "modify", before, file };
    } else if (value.kind === "delete") {
      if (!hasExactKeys(value, ["kind", "before"])) {
        throw new Error("delete 候选操作格式无效");
      }
      const before = validateWorkspaceFile(value.before, "删除前", policy);
      const baselineFile = baseline.files.get(before.path);
      if (
        !baselineFile ||
        !workspaceFilesEqual(
          validateWorkspaceFile(baselineFile, "基线", policy),
          before,
        )
      ) {
        throw new Error(`删除操作 before 与基线不一致: ${before.path}`);
      }
      path = before.path;
      operation = { kind: "delete", before };
    } else {
      throw new Error(`未知候选操作: ${value.kind}`);
    }

    const pathKey = protectedFilesystemPathKey(path);
    if (pathKeys.has(pathKey)) {
      throw new Error(`候选操作包含重复或别名路径: ${path}`);
    }
    pathKeys.add(pathKey);
    prepared.push({
      operation,
      path,
      destination: join(baseline.root, path),
    });
  }

  prepared.sort((left, right) => comparePaths(left.path, right.path));
  return prepared;
}

function preflightHost(
  baseline: WorkspaceSnapshot,
  prepared: PreparedOperation[],
): void {
  for (const item of prepared) {
    assertSafeParents(baseline.root, item.path);
    if (item.operation.kind === "add") {
      if (lstatIfPresent(item.destination)) {
        throw new Error(`新增目标已存在: ${item.path}`);
      }
    } else {
      assertCurrentMatches(item.destination, item.operation.before);
    }
  }
}

function failure(error: unknown): PublicationResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, changedFiles: [], conflict: message };
}

export function publishCandidate(
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): PublicationResult {
  let prepared: PreparedOperation[];
  try {
    prepared = prepareOperations(baseline, candidate, policy);
    preflightHost(baseline, prepared);
  } catch (error) {
    return failure(error);
  }

  const staged: StagedWrite[] = [];
  try {
    for (const item of prepared) {
      if (item.operation.kind === "delete") continue;

      mkdirSync(dirname(item.destination), { recursive: true });
      const temporary =
        `${item.destination}.harness-${randomUUID()}.tmp`;
      staged.push({ temporary, destination: item.destination });
      const mode = item.operation.file.executable ? 0o755 : 0o644;
      writeFileSync(temporary, item.operation.file.content, {
        flag: "wx",
        mode,
      });
      chmodSync(temporary, mode);
    }

    for (const item of staged) {
      renameSync(item.temporary, item.destination);
    }
    for (const item of prepared) {
      if (item.operation.kind === "delete") {
        unlinkSync(item.destination);
      }
    }
  } catch (error) {
    for (const item of staged) {
      try {
        rmSync(item.temporary, { force: true });
      } catch {
        // Preserve the primary publication failure.
      }
    }
    return failure(error);
  }

  return {
    ok: true,
    changedFiles: prepared.map((item) => item.path),
  };
}

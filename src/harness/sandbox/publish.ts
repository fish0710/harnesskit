import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  protectedFilesystemPathKey,
  validateCandidatePath,
} from "./policy.js";
import {
  agentVisibleFiles,
  deriveCandidateOperations,
} from "./workspace.js";
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

/** Test-only synchronization points for deterministic race/failure coverage. */
export interface PublishHooks {
  afterStage?(): void;
  beforeInstall?(path: string, index: number): void;
}

interface PreparedOperation {
  operation: CandidateOperation;
  path: string;
  destination: string;
}

interface StagedWrite {
  path: string;
  temporary: string;
  destination: string;
}

interface InstalledWrite {
  destination: string;
  device: number;
  inode: number;
}

interface Backup {
  path: string;
  backup: string;
  destination: string;
  before: WorkspaceFile;
}

interface CreatedDirectory {
  path: string;
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["path", "content", "executable", "sha256"])
  ) {
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

function operationPath(operation: CandidateOperation): string {
  return operation.kind === "delete"
    ? operation.before.path
    : operation.file.path;
}

function operationsEqual(
  left: CandidateOperation,
  right: CandidateOperation,
): boolean {
  if (left.kind !== right.kind || operationPath(left) !== operationPath(right)) {
    return false;
  }
  if (left.kind === "add" && right.kind === "add") {
    return workspaceFilesEqual(left.file, right.file);
  }
  if (left.kind === "delete" && right.kind === "delete") {
    return workspaceFilesEqual(left.before, right.before);
  }
  if (left.kind === "modify" && right.kind === "modify") {
    return (
      workspaceFilesEqual(left.before, right.before) &&
      workspaceFilesEqual(left.file, right.file)
    );
  }
  return false;
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

function assertInsideRoot(root: string, destination: string, path: string): void {
  const rel = relative(root, destination);
  if (
    rel.startsWith("../") ||
    rel === ".." ||
    resolve(root, rel) !== destination
  ) {
    throw new Error(`发布路径越界: ${path}`);
  }
}

function assertSafeParents(root: string, path: string): void {
  const rootStat = lstatIfPresent(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`工作区根目录类型冲突: ${root}`);
  }
  const realRoot = realpathSync(root);
  const destination = join(root, path);
  assertInsideRoot(root, destination, path);

  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`父路径包含符号链接: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`父路径不是目录: ${path}`);
    }
    const realCurrent = realpathSync(current);
    const rel = relative(realRoot, realCurrent);
    if (rel === ".." || rel.startsWith("../")) {
      throw new Error(`父路径位于工作区外: ${path}`);
    }
  }
}

function assertCurrentMatches(
  destination: string,
  before: WorkspaceFile,
): void {
  const stat = lstatIfPresent(destination);
  if (!stat) throw new Error(`主机文件已不存在: ${before.path}`);
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

function validateCandidateFiles(
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): Map<string, WorkspaceFile> {
  if (!(candidate.files instanceof Map)) {
    throw new Error("候选文件映射格式无效");
  }
  const validated = new Map<string, WorkspaceFile>();
  const aliases = new Set<string>();
  let totalBytes = 0;
  for (const [key, rawFile] of candidate.files.entries()) {
    if (typeof key !== "string") throw new Error("候选文件映射键格式无效");
    const file = validateWorkspaceFile(rawFile, "候选", policy);
    if (key !== file.path) {
      throw new Error(`候选文件映射键与路径不一致: ${key}`);
    }
    const alias = protectedFilesystemPathKey(file.path);
    if (validated.has(file.path) || aliases.has(alias)) {
      throw new Error(`候选文件映射包含重复或别名路径: ${file.path}`);
    }
    if (file.content.byteLength > policy.limits.maxFileBytes) {
      throw new Error(`候选文件超过大小限制: ${file.path}`);
    }
    if (file.content.byteLength > policy.limits.maxTotalBytes - totalBytes) {
      throw new Error("候选文件总大小超过限制");
    }
    totalBytes += file.content.byteLength;
    if (validated.size + 1 > policy.limits.maxFiles) {
      throw new Error("候选文件数量超过限制");
    }
    validated.set(file.path, file);
    aliases.add(alias);
  }
  return validated;
}

function validateSuppliedOperations(
  operations: unknown,
  policy: SandboxPolicy,
): CandidateOperation[] {
  if (!Array.isArray(operations)) throw new Error("候选操作列表格式无效");
  const validated: CandidateOperation[] = [];
  for (const value of operations) {
    if (!isRecord(value) || typeof value.kind !== "string") {
      throw new Error("候选操作格式无效");
    }
    if (value.kind === "add" && hasExactKeys(value, ["kind", "file"])) {
      validated.push({
        kind: "add",
        file: validateWorkspaceFile(value.file, "新增", policy),
      });
    } else if (
      value.kind === "modify" &&
      hasExactKeys(value, ["kind", "before", "file"])
    ) {
      const before = validateWorkspaceFile(value.before, "修改前", policy);
      const file = validateWorkspaceFile(value.file, "修改后", policy);
      if (before.path !== file.path) {
        throw new Error(`修改操作路径不一致: ${before.path}`);
      }
      validated.push({ kind: "modify", before, file });
    } else if (
      value.kind === "delete" &&
      hasExactKeys(value, ["kind", "before"])
    ) {
      validated.push({
        kind: "delete",
        before: validateWorkspaceFile(value.before, "删除前", policy),
      });
    } else {
      throw new Error(`未知或格式无效的候选操作: ${value.kind}`);
    }
  }
  return validated.sort((left, right) =>
    comparePaths(operationPath(left), operationPath(right))
  );
}

function prepareOperations(
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): PreparedOperation[] {
  if (!isRecord(candidate)) throw new Error("候选快照格式无效");
  const files = validateCandidateFiles(candidate, policy);
  const expected = deriveCandidateOperations(baseline, files, policy);
  const supplied = validateSuppliedOperations(candidate.operations, policy);
  if (
    expected.length !== supplied.length ||
    expected.some((operation, index) =>
      !operationsEqual(operation, supplied[index]!)
    )
  ) {
    throw new Error("候选操作与已评估候选文件不一致");
  }

  const baselineMutable = new Map(
    agentVisibleFiles(baseline, policy).map((file) => [file.path, file]),
  );
  const aliases = new Set<string>();
  return expected.map((operation) => {
    const path = operationPath(operation);
    const alias = protectedFilesystemPathKey(path);
    if (aliases.has(alias)) {
      throw new Error(`候选操作包含重复或别名路径: ${path}`);
    }
    aliases.add(alias);
    if (operation.kind !== "add") {
      const baselineFile = baselineMutable.get(path);
      if (!baselineFile || !workspaceFilesEqual(baselineFile, operation.before)) {
        throw new Error(`候选操作 before 与基线不一致: ${path}`);
      }
    }
    return {
      operation,
      path,
      destination: join(baseline.root, path),
    };
  });
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
  return {
    ok: false,
    changedFiles: [],
    conflict: error instanceof Error ? error.message : String(error),
  };
}

function removeIfPresent(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup is best effort; the primary failure is preserved.
  }
}

function removeInstalledWrites(installed: InstalledWrite[]): string[] {
  const failures: string[] = [];
  for (const item of [...installed].reverse()) {
    const stat = lstatIfPresent(item.destination);
    if (!stat) continue;
    if (stat.dev !== item.device || stat.ino !== item.inode) {
      failures.push(`发布目标被并发替换，未删除: ${item.destination}`);
      continue;
    }
    try {
      unlinkSync(item.destination);
    } catch (error) {
      failures.push(
        `无法移除已发布文件 ${item.destination}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return failures;
}

function removeCreatedDirectories(
  directories: CreatedDirectory[],
): string[] {
  const failures: string[] = [];
  for (const item of [...directories].reverse()) {
    try {
      rmdirSync(item.path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTEMPTY")
      ) {
        continue;
      }
      failures.push(
        `无法移除发布创建的目录 ${item.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return failures;
}

function ensureParentDirectories(
  root: string,
  path: string,
  created: CreatedDirectory[],
): void {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const existing = lstatIfPresent(current);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`父路径不是安全目录: ${path}`);
      }
      continue;
    }
    try {
      mkdirSync(current);
      created.push({ path: current });
    } catch (error) {
      const raced = lstatIfPresent(current);
      if (!raced || raced.isSymbolicLink() || !raced.isDirectory()) {
        throw error;
      }
    }
  }
}

function restoreBackups(backups: Backup[]): string[] {
  const failures: string[] = [];
  for (const item of [...backups].reverse()) {
    if (lstatIfPresent(item.destination)) {
      failures.push(
        `无法恢复 ${item.path}，原始内容保留在 ${item.backup}`,
      );
      continue;
    }
    try {
      renameSync(item.backup, item.destination);
    } catch (error) {
      failures.push(
        `无法恢复 ${item.path}，原始内容保留在 ${item.backup}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return failures;
}

function rollbackFailure(
  error: unknown,
  installed: InstalledWrite[],
  backups: Backup[],
  createdDirectories: CreatedDirectory[],
): PublicationResult {
  const rollbackFailures = [
    ...removeInstalledWrites(installed),
    ...restoreBackups(backups),
    ...removeCreatedDirectories(createdDirectories),
  ];
  const primary = error instanceof Error ? error.message : String(error);
  return failure(
    rollbackFailures.length === 0
      ? primary
      : `${primary}; 回滚未完全完成: ${rollbackFailures.join("; ")}`,
  );
}

export function publishCandidate(
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
  hooks: PublishHooks = {},
): PublicationResult {
  let prepared: PreparedOperation[];
  try {
    prepared = prepareOperations(baseline, candidate, policy);
    preflightHost(baseline, prepared);
  } catch (error) {
    return failure(error);
  }

  const staged: StagedWrite[] = [];
  const backups: Backup[] = [];
  const installed: InstalledWrite[] = [];
  const createdDirectories: CreatedDirectory[] = [];
  try {
    for (const item of prepared) {
      if (item.operation.kind === "delete") continue;
      assertSafeParents(baseline.root, item.path);
      ensureParentDirectories(
        baseline.root,
        item.path,
        createdDirectories,
      );
      const temporary = `${item.destination}.harness-${randomUUID()}.tmp`;
      const mode = item.operation.file.executable ? 0o755 : 0o644;
      writeFileSync(temporary, item.operation.file.content, {
        flag: "wx",
        mode,
      });
      chmodSync(temporary, mode);
      staged.push({
        path: item.path,
        temporary,
        destination: item.destination,
      });
    }

    hooks.afterStage?.();
    preflightHost(baseline, prepared);

    for (const item of prepared) {
      if (item.operation.kind === "add") continue;
      assertSafeParents(baseline.root, item.path);
      assertCurrentMatches(item.destination, item.operation.before);
      const backup = `${item.destination}.harness-${randomUUID()}.bak`;
      renameSync(item.destination, backup);
      const record: Backup = {
        path: item.path,
        backup,
        destination: item.destination,
        before: item.operation.before,
      };
      backups.push(record);
      assertCurrentMatches(backup, item.operation.before);
    }

    let installIndex = 0;
    for (const stagedWrite of staged) {
      hooks.beforeInstall?.(stagedWrite.path, installIndex++);
      assertSafeParents(baseline.root, stagedWrite.path);
      linkSync(stagedWrite.temporary, stagedWrite.destination);
      const installedStat = lstatSync(stagedWrite.destination);
      installed.push({
        destination: stagedWrite.destination,
        device: installedStat.dev,
        inode: installedStat.ino,
      });
      unlinkSync(stagedWrite.temporary);
    }
  } catch (error) {
    for (const item of staged) removeIfPresent(item.temporary);
    const result = rollbackFailure(
      error,
      installed,
      backups,
      createdDirectories,
    );
    return result;
  }

  for (const item of backups) removeIfPresent(item.backup);
  for (const item of staged) removeIfPresent(item.temporary);
  return {
    ok: true,
    changedFiles: prepared.map((item) => item.path),
  };
}

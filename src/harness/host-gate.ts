import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { GateCore } from "../gate.js";
import type { Contract, GateReport, RunContext } from "../types.js";
import {
  normalizeWorkspacePath,
  validateCandidatePath,
} from "./sandbox/policy.js";
import type {
  CandidateSnapshot,
  SandboxPolicy,
  WorkspaceFile,
  WorkspaceSnapshot,
} from "./sandbox/types.js";
import { agentVisibleFiles } from "./sandbox/workspace.js";

export interface HostLocalGateOptions {
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  baseline: WorkspaceSnapshot;
  candidate: CandidateSnapshot;
  policy: SandboxPolicy;
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
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(root, rel) !== destination
  ) {
    throw new Error(`主机候选路径越界: ${path}`);
  }
}

function assertRealPathInsideRoot(
  realRoot: string,
  realPath: string,
  path: string,
): void {
  const rel = relative(realRoot, realPath);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(realRoot, rel) !== realPath
  ) {
    throw new Error(`主机候选父路径位于工作区外: ${path}`);
  }
}

function assertSafeParents(root: string, path: string): void {
  const rootStat = lstatIfPresent(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`主机候选根目录类型冲突: ${root}`);
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
      throw new Error(`主机候选父路径包含符号链接: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`主机候选父路径不是目录: ${path}`);
    }
    assertRealPathInsideRoot(realRoot, realpathSync(current), path);
  }
}

function assertSafeDestination(root: string, path: string): void {
  assertSafeParents(root, path);
  const stat = lstatIfPresent(join(root, path));
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`主机候选文件是符号链接: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`主机候选文件不是普通文件: ${path}`);
  }
}

function writeWorkspaceFile(root: string, file: WorkspaceFile): void {
  const path = normalizeWorkspacePath(file.path);
  const destination = join(root, path);
  assertSafeParents(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  assertSafeDestination(root, path);
  writeFileSync(destination, file.content);
  chmodSync(destination, file.executable ? 0o755 : 0o644);
}

function removeIfPresent(root: string, path: string): void {
  const normalized = normalizeWorkspacePath(path);
  assertSafeParents(root, normalized);
  try {
    unlinkSync(join(root, normalized));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export function materializeCandidateWorkspace(
  root: string,
  baseline: WorkspaceSnapshot,
  candidate: CandidateSnapshot,
  policy: SandboxPolicy,
): void {
  const mutableBaselineFiles = agentVisibleFiles(baseline, policy);
  const candidateFiles = [...candidate.files.values()];

  // Candidate snapshots are expected to come from collectCandidate(); keep this
  // host-exported boundary fail-closed for path authorization before writing.
  for (const file of candidateFiles) {
    validateCandidatePath(file.path, policy);
  }

  for (const file of baseline.files.values()) {
    writeWorkspaceFile(root, file);
  }
  for (const file of mutableBaselineFiles) {
    removeIfPresent(root, file.path);
  }
  for (const file of candidateFiles) {
    writeWorkspaceFile(root, file);
  }
}

export async function runHostLocalGate(
  options: HostLocalGateOptions,
): Promise<GateReport> {
  const root = mkdtempSync(join(tmpdir(), "harness-host-gate-"));
  try {
    materializeCandidateWorkspace(
      root,
      options.baseline,
      options.candidate,
      options.policy,
    );
    return await options.gate.run(options.contracts, {
      ...options.ctx,
      cwd: root,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function isHostLocalContract(contract: Contract): boolean {
  return contract.type === "miniprogram";
}

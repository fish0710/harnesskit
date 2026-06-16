import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function writeWorkspaceFile(root: string, file: WorkspaceFile): void {
  const path = normalizeWorkspacePath(file.path);
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content);
  chmodSync(destination, file.executable ? 0o755 : 0o644);
}

function removeIfPresent(root: string, path: string): void {
  try {
    unlinkSync(join(root, normalizeWorkspacePath(path)));
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

  for (const file of baseline.files.values()) {
    writeWorkspaceFile(root, file);
  }
  for (const file of mutableBaselineFiles) {
    removeIfPresent(root, file.path);
  }
  for (const file of candidate.files.values()) {
    validateCandidatePath(file.path, policy);
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

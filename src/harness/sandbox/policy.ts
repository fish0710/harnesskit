import type { SandboxLimits, SandboxPolicy } from "./types.js";

const DEFAULT_POLICY: SandboxPolicy = {
  candidateRoots: [
    "src",
    "lib",
    "test/generated",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ],
  protectedPaths: [
    "contracts",
    ".harness",
    "harness.config.json",
    ".github/workflows",
    "CODEOWNERS",
  ],
  agentSetup: [],
  gateSetup: [],
  limits: {
    maxFiles: 10_000,
    maxFileBytes: 10 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
  },
  retainOnFailure: false,
};

const SANDBOX_FIELDS = new Set([
  "candidateRoots",
  "protectedPaths",
  "agentSetup",
  "gateSetup",
  "limits",
  "retainOnFailure",
]);

const LIMIT_FIELDS = new Set([
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  knownFields: Set<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!knownFields.has(field)) {
      throw new Error(`未知 ${label} 字段: ${field}`);
    }
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${field} 必须是字符串数组`);
  }
  return [...value];
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${field} 必须是正安全整数`);
  }
  return value;
}

function securityKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isWithin(path: string, prefix: string): boolean {
  const pathKey = securityKey(path);
  const prefixKey = securityKey(prefix);
  return pathKey === prefixKey || pathKey.startsWith(`${prefixKey}/`);
}

export function normalizeWorkspacePath(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("工作区路径必须是字符串");
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`绝对路径不允许: ${value}`);
  }

  const parts = value.split("/");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("//") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`非法路径或越界路径: ${value}`);
  }
  return value;
}

export function validateCandidatePath(
  value: string,
  policy: SandboxPolicy,
): string {
  const path = normalizeWorkspacePath(value);
  if (!policy.candidateRoots.some((root) => isWithin(path, root))) {
    throw new Error(`候选路径不在允许范围: ${path}`);
  }
  if (policy.protectedPaths.some((root) => isWithin(path, root))) {
    throw new Error(`候选路径属于受保护资产: ${path}`);
  }
  return path;
}

function loadLimits(value: unknown): SandboxLimits {
  if (!isRecord(value)) {
    throw new TypeError("sandbox.limits 配置必须是普通对象");
  }
  rejectUnknownFields(value, LIMIT_FIELDS, "sandbox.limits");

  return {
    maxFiles: !hasOwn(value, "maxFiles")
      ? DEFAULT_POLICY.limits.maxFiles
      : positiveSafeInteger(value.maxFiles, "maxFiles"),
    maxFileBytes: !hasOwn(value, "maxFileBytes")
      ? DEFAULT_POLICY.limits.maxFileBytes
      : positiveSafeInteger(value.maxFileBytes, "maxFileBytes"),
    maxTotalBytes: !hasOwn(value, "maxTotalBytes")
      ? DEFAULT_POLICY.limits.maxTotalBytes
      : positiveSafeInteger(value.maxTotalBytes, "maxTotalBytes"),
  };
}

export function loadSandboxPolicy(config: unknown): SandboxPolicy {
  if (!isRecord(config)) {
    throw new TypeError("Harness 配置必须是普通对象");
  }

  if (!hasOwn(config, "sandbox")) {
    return {
      candidateRoots: [...DEFAULT_POLICY.candidateRoots],
      protectedPaths: [...DEFAULT_POLICY.protectedPaths],
      agentSetup: [...DEFAULT_POLICY.agentSetup],
      gateSetup: [...DEFAULT_POLICY.gateSetup],
      limits: { ...DEFAULT_POLICY.limits },
      retainOnFailure: DEFAULT_POLICY.retainOnFailure,
    };
  }
  const sandboxValue = config.sandbox;
  if (!isRecord(sandboxValue)) {
    throw new TypeError("sandbox 配置必须是普通对象");
  }
  rejectUnknownFields(sandboxValue, SANDBOX_FIELDS, "sandbox");

  const candidateRoots = !hasOwn(sandboxValue, "candidateRoots")
    ? [...DEFAULT_POLICY.candidateRoots]
    : stringArray(sandboxValue.candidateRoots, "candidateRoots")
      .map(normalizeWorkspacePath);
  if (candidateRoots.length === 0) {
    throw new Error("candidateRoots 必须是非空数组");
  }

  const protectedPaths = !hasOwn(sandboxValue, "protectedPaths")
    ? [...DEFAULT_POLICY.protectedPaths]
    : stringArray(sandboxValue.protectedPaths, "protectedPaths")
      .map(normalizeWorkspacePath);
  const agentSetup = !hasOwn(sandboxValue, "agentSetup")
    ? [...DEFAULT_POLICY.agentSetup]
    : stringArray(sandboxValue.agentSetup, "agentSetup");
  const gateSetup = !hasOwn(sandboxValue, "gateSetup")
    ? [...DEFAULT_POLICY.gateSetup]
    : stringArray(sandboxValue.gateSetup, "gateSetup");
  const limits = !hasOwn(sandboxValue, "limits")
    ? { ...DEFAULT_POLICY.limits }
    : loadLimits(sandboxValue.limits);

  const retainValue = sandboxValue.retainOnFailure;
  if (
    hasOwn(sandboxValue, "retainOnFailure") &&
    typeof retainValue !== "boolean"
  ) {
    throw new TypeError("retainOnFailure 必须是布尔值");
  }
  const retainOnFailure = hasOwn(sandboxValue, "retainOnFailure")
    ? retainValue as boolean
    : DEFAULT_POLICY.retainOnFailure;

  if (
    candidateRoots.every((candidateRoot) =>
      protectedPaths.some((protectedPath) =>
        isWithin(candidateRoot, protectedPath),
      ),
    )
  ) {
    throw new Error("所有 candidateRoots 都完全受保护，候选区不可写");
  }

  return {
    candidateRoots,
    protectedPaths,
    agentSetup,
    gateSetup,
    limits,
    retainOnFailure,
  };
}

import { randomUUID } from "node:crypto";
import { posix } from "node:path";

export const DEFAULT_DAYTONA_OBSERVABILITY_VOLUME =
  "harness-claude-observability";
export const DEFAULT_DAYTONA_OBSERVABILITY_MOUNT = "/harness-observability";
export const DEFAULT_DAYTONA_CLAUDE_HOME_CONFIG_DIR = "/home/daytona/.claude";

export type DaytonaObservabilityBackend = "daytona-volume" | "disabled";

export interface DaytonaObservabilityConfig {
  enabled: boolean;
  backend: DaytonaObservabilityBackend;
  volumeName: string;
  mountPath: string;
}

export interface ClaudeObservabilityPaths {
  runRoot: string;
  attemptRoot: string;
  claudeConfigDir: string;
  manifestPath: string;
}

export interface MountedClaudeObservabilityPaths {
  runRoot: string;
  attemptRoot: string;
  claudeConfigDir: string;
  manifestPath: string;
}

type Environment = Record<string, string | undefined>;

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["0", "false", "off"].includes(value.trim().toLowerCase());
}

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.includes("\0") ||
    !posix.isAbsolute(trimmed)
  ) {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_MOUNT must be an absolute POSIX path",
    );
  }
  const normalized = posix.join(posix.normalize(trimmed), ".");
  if (normalized === "/") {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_MOUNT must not be the filesystem root",
    );
  }
  return normalized;
}

function assertSafeRunId(runId: string): void {
  if (
    runId === "" ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error("runId must be a non-empty safe path segment");
  }
}

export function loadDaytonaObservabilityConfig(
  environment: Environment,
): DaytonaObservabilityConfig {
  if (isDisabled(environment.HARNESS_DAYTONA_OBSERVABILITY)) {
    return {
      enabled: false,
      backend: "disabled",
      volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
      mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
    };
  }
  const volumeName = (
    environment.HARNESS_DAYTONA_OBSERVABILITY_VOLUME ??
      DEFAULT_DAYTONA_OBSERVABILITY_VOLUME
  ).trim();
  if (!volumeName) {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_VOLUME must not be blank",
    );
  }
  const mountPath = normalizeMountPath(
    environment.HARNESS_DAYTONA_OBSERVABILITY_MOUNT ??
      DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  );
  return {
    enabled: true,
    backend: "daytona-volume",
    volumeName,
    mountPath,
  };
}

export function buildRunId(
  now = new Date(),
  randomId: () => string = randomUUID,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = randomId().replaceAll("-", "").replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8);
  if (suffix.length < 8) {
    throw new Error("random id must contain at least 8 safe characters");
  }
  return `${stamp}-${suffix}`;
}

export function claudeObservabilityPaths(
  config: DaytonaObservabilityConfig,
  runId: string,
  attempt: number,
): ClaudeObservabilityPaths {
  if (!config.enabled) {
    throw new Error("Claude observability paths are disabled");
  }
  assertSafeRunId(runId);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive safe integer");
  }
  const runRoot = posix.join(config.mountPath, "runs", runId);
  const attemptRoot = posix.join(runRoot, `attempt-${attempt}`);
  return {
    runRoot,
    attemptRoot,
    claudeConfigDir: posix.join(runRoot, ".claude"),
    manifestPath: posix.join(attemptRoot, "manifest.json"),
  };
}

export function claudeObservabilityVolumeSubpath(runId: string): string {
  assertSafeRunId(runId);
  return posix.join("runs", runId);
}

export function mountedClaudeObservabilityPaths(
  config: DaytonaObservabilityConfig,
  attempt: number,
): MountedClaudeObservabilityPaths {
  if (!config.enabled) {
    throw new Error("Mounted Claude observability paths are disabled");
  }
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive safe integer");
  }
  const runRoot = config.mountPath;
  const attemptRoot = posix.join(runRoot, `attempt-${attempt}`);
  return {
    runRoot,
    attemptRoot,
    claudeConfigDir: DEFAULT_DAYTONA_CLAUDE_HOME_CONFIG_DIR,
    manifestPath: posix.join(attemptRoot, "manifest.json"),
  };
}

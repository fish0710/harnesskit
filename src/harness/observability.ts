import { randomUUID } from "node:crypto";
import { posix } from "node:path";

export const DEFAULT_DAYTONA_OBSERVABILITY_VOLUME =
  "harness-claude-observability";
export const DEFAULT_DAYTONA_OBSERVABILITY_MOUNT = "/harness-observability";

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
  const normalized = posix.normalize(trimmed);
  if (normalized === "/") {
    throw new Error(
      "HARNESS_DAYTONA_OBSERVABILITY_MOUNT must not be the filesystem root",
    );
  }
  return normalized;
}

export function loadDaytonaObservabilityConfig(
  environment: Environment,
): DaytonaObservabilityConfig {
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
  if (isDisabled(environment.HARNESS_DAYTONA_OBSERVABILITY)) {
    return {
      enabled: false,
      backend: "disabled",
      volumeName,
      mountPath,
    };
  }
  return {
    enabled: true,
    backend: "daytona-volume",
    volumeName,
    mountPath,
  };
}

export function buildRunId(
  now = new Date(),
  randomId = randomUUID,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomId().replaceAll("-", "").slice(0, 8)}`;
}

export function claudeObservabilityPaths(
  config: DaytonaObservabilityConfig,
  runId: string,
  attempt: number,
): ClaudeObservabilityPaths {
  if (!config.enabled) {
    throw new Error("Claude observability paths are disabled");
  }
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive safe integer");
  }
  const runRoot = posix.join(config.mountPath, "runs", runId);
  const attemptRoot = posix.join(runRoot, `attempt-${attempt}`);
  return {
    runRoot,
    attemptRoot,
    claudeConfigDir: posix.join(attemptRoot, ".claude"),
  };
}

import type { AgentSpec } from "./drivers.js";
import type { GenerationBudget } from "./run.js";

export const DEFAULT_RUN_LOOP_MAX_MS = 6_000_000;

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} 必须是正整数`);
  }
  return parsed;
}

export function buildGenerationBudget(
  values: Record<string, unknown>,
  agent: AgentSpec,
): GenerationBudget {
  const def = agent.kind === "scaffold" ? 1 : 5;
  const maxAttempts = optionalPositiveInteger(
    values["max-attempts"],
    "maxAttempts",
  ) ?? def;
  const maxMs = optionalPositiveInteger(
    values["max-ms"] ?? values.maxMs,
    "maxMs",
  ) ?? DEFAULT_RUN_LOOP_MAX_MS;
  return {
    maxAttempts,
    maxTokens: 1e9,
    maxMs,
    contextThreshold: 0.9,
    repeatWallThreshold: 3,
  };
}

// gate_core 公共 API
export * from "./types.js";
export { PluginRegistry } from "./registry.js";
export { GateCore } from "./gate.js";
export { aggregate, resolveWithVerdict } from "./aggregate.js";
export { renderPretty, renderJson } from "./reporter.js";
export {
  loadContracts, validateContract, contractHash, freezeContract, verifyFrozen,
  type LoadResult, type ValidationIssue,
} from "./contracts.js";
export { selectByChange, selectByStage, type SelectConfig } from "./selector.js";

// Agent 集成
export { decideEscalation, type LoopState, type EscalationAction } from "./agent/escalation.js";

// 产出引擎(完整 harness CLI 的核心层)
export {
  scaffoldDriver, commandDriver, claudeDriver, buildClaudeQueryOptions,
  type AgentDriver, type AgentTaskInput, type AgentTaskResult,
  type ClaudeDriverOptions, type ClaudeDriverDependencies, type ClaudePermissionMode,
} from "./harness/drivers.js";
export {
  startLangfuseObservability, CLAUDE_AGENT_INSTRUMENTATION_SCOPE,
  type ClaudeQuery, type ClaudeSdkModule, type LangfuseDependencies,
  type LangfuseObservability, type StartLangfuseOptions,
} from "./harness/langfuse.js";
export {
  runLoop, localRunEnvironment,
  type RunEnvironment, type EnvironmentTaskInput,
  type RunOptions, type RunOutcome, type GenerationBudget,
} from "./harness/run.js";
export { loadVerdicts, recordVerdict } from "./harness/verdicts.js";
export { writeRunRecord, lastRunRecord, type RunRecord } from "./harness/record.js";
export { createProject, type CreateResult } from "./harness/scaffold.js";
export { writePlan } from "./harness/plan.js";
export { gatherStatus } from "./harness/status.js";

// 内置示例插件（也是“如何写插件”的范例）
export { commandPlugin } from "./plugins/command.js";
export { bootPlugin } from "./plugins/boot.js";
export { reviewPlugin } from "./plugins/review.js";
export { httpPlugin } from "./plugins/http.js";
export { structurePlugin } from "./plugins/structure.js";
export { createInvariantPlugin, type Property } from "./plugins/invariant.js";
export { spawnCapture, type SpawnResult } from "./util/spawn.js";

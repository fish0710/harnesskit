/**
 * 止损升级决策(纯函数,可测)。
 * 对应计划书 §6 的“三种信号 → 三种动作”:别让 agent 无限空转、成本递增。
 *
 *   context 将满       → swap_instance:带移交笔记换新实例续上(优先,避免降级丢工作)
 *   反复撞同一堵墙     → human_review_contract:很可能是契约本身错了,升人审
 *   预算耗尽           → stop_for_human:转 N 轮 / token / 时长超限,停下交人
 *   否则               → continue
 */

export interface LoopState {
  attempts: number;
  maxAttempts: number;
  tokensUsed: number;
  maxTokens: number;
  elapsedMs: number;
  maxMs: number;
  /** 当前 context 占用比例 0..1。 */
  contextUsedRatio: number;
  /** 触发换实例的 context 阈值,如 0.85。 */
  contextThreshold: number;
  /** 每个 check 的连续失败次数。 */
  failStreakByCheck: Record<string, number>;
  /** 同一 check 连续失败多少次判定为“撞墙”,如 3。 */
  repeatWallThreshold: number;
}

export type EscalationAction =
  | { kind: "continue" }
  | { kind: "swap_instance"; reason: string }
  | { kind: "human_review_contract"; checkId: string; reason: string }
  | { kind: "stop_for_human"; reason: string };

export function decideEscalation(s: LoopState): EscalationAction {
  // 1) context 焦虑优先:再不换实例,agent 会为了收尾而糊弄
  if (s.contextUsedRatio >= s.contextThreshold) {
    return {
      kind: "swap_instance",
      reason: `context 占用 ${(s.contextUsedRatio * 100).toFixed(0)}% ≥ 阈值 ${(s.contextThreshold * 100).toFixed(0)}%:带移交笔记换新实例续上`,
    };
  }

  // 2) 反复撞同一堵墙:常常是契约/表征本身错了,升人审而非让 agent 继续耗
  for (const [checkId, streak] of Object.entries(s.failStreakByCheck)) {
    if (streak >= s.repeatWallThreshold) {
      return {
        kind: "human_review_contract",
        checkId,
        reason: `检查 "${checkId}" 连续失败 ${streak} 次(≥${s.repeatWallThreshold}):很可能是契约本身有问题,请人确认契约是否抓对`,
      };
    }
  }

  // 3) 预算耗尽:停下交人
  if (s.attempts >= s.maxAttempts) {
    return { kind: "stop_for_human", reason: `已尝试 ${s.attempts} 轮(≥${s.maxAttempts}),停下交人` };
  }
  if (s.tokensUsed >= s.maxTokens) {
    return { kind: "stop_for_human", reason: `已用 ${s.tokensUsed} tokens(≥${s.maxTokens}),停下交人` };
  }
  if (s.elapsedMs >= s.maxMs) {
    return { kind: "stop_for_human", reason: `已耗时 ${(s.elapsedMs / 1000).toFixed(0)}s(≥${(s.maxMs / 1000).toFixed(0)}s),停下交人` };
  }

  return { kind: "continue" };
}

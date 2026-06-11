import type { ExecutionTarget } from "./harness/execution.js";

/**
 * gate_core 类型定义 —— 整个内核的契约都在这里。
 *
 * 两条贯穿的红线直接编码进类型:
 *  1. status 区分 fail 与 error：error ≠ pass（没跑成绝不当通过）。
 *  2. 在 pass/fail/error 之外引入 needs_review：有些判定机器做不了，
 *     必须把“决策重点”结构化地交给人——这就是 DecisionRequest。
 */

/** 单条检查的状态。注意 error 与 fail 是两回事，needs_review 不是失败也不是通过。 */
export type Status =
  | "pass"          // 跑了，通过
  | "fail"          // 跑了，发现违规
  | "error"         // 没跑成（插件缺失/崩溃/返回不可信）——绝不可当 pass
  | "needs_review"; // 机器判不了，需人工决策（携带 DecisionRequest）

/** 一条违规：永远同时给 what / why / how，让 agent 或人能直接行动。 */
export interface Violation {
  what: string;        // 抓到什么
  why: string;         // 为什么不行
  how: string;         // 怎么改
  file?: string;
  line?: number;
  ref?: string;        // 关联文档，如 docs/decisions/0001.md
}

/** 决策证据：呈现给人的支撑信息（键值对，便于排版）。 */
export interface Evidence {
  label: string;
  value: string;
}

/** 一个可选裁决项：人选了它，这条检查就被解析成 pass 或 fail。 */
export interface DecisionOption {
  id: string;
  label: string;
  resolvesTo: "pass" | "fail";
}

/**
 * 人工决策请求 —— “展示决策重点”的核心数据结构。
 * 插件返回 needs_review 时必须给出它：人看到的不是一堆原始日志，
 * 而是“要决定什么 + 该聚焦哪几点 + 支撑证据 + 可选裁决”。
 */
export interface DecisionRequest {
  question: string;          // 需要人决定的那一个问题
  focalPoints: string[];     // 决策重点：让人聚焦的关键考量（机器替不了的判断点）
  evidence: Evidence[];      // 支撑证据
  options: DecisionOption[]; // 可选裁决（至少一个 pass、一个 fail）
  recommended?: string;      // 可给建议(option id)，但不替代人；仅作提示
}

/** 人给出的裁决（可被持久化、可追溯）。 */
export interface Verdict {
  optionId: string;
  by: string;       // 谁裁决的
  at: string;       // ISO 时间
  reason?: string;
}

/** 一条检查的结果。 */
export interface CheckResult {
  id: string;
  type: string;
  status: Status;
  durationMs: number;
  violations: Violation[];
  errorReason?: string;        // status==="error" 时：为什么没跑成
  decision?: DecisionRequest;  // status==="needs_review" 时：交给人的决策重点
}

/** 一个待检查的契约。type 决定由哪个插件处理；其余字段由插件解释。 */
export interface Contract {
  id: string;
  type: string;
  scenario?: string;
  owner?: string;
  frozen?: boolean;
  /** type 专属载荷（trigger/expect/cmd/...），由对应插件读取。 */
  [key: string]: unknown;
}

/** 运行上下文。verdicts 携带“已记录的人工裁决”，用于解析 needs_review。 */
export interface RunContext {
  cwd: string;
  verdicts?: Record<string, Verdict>;
  signal?: AbortSignal;
  execution?: ExecutionTarget;
}

/** 元测试结果：插件用契约自带的 examples 标定自己是否“没瞎”。 */
export interface CalibrationResult {
  ok: boolean;
  details: string[];
}

/**
 * 插件契约 —— “保证扩展性”的扩展点。
 * 加一种新检查 = 实现这个接口并 gate.use(plugin)，内核无需改动。
 */
export interface Plugin {
  /** 处理的契约 type，全局唯一。 */
  readonly type: string;
  /** 执行检查，返回结构化结果。务必区分 fail 与 error。 */
  run(contract: Contract, ctx: RunContext): Promise<CheckResult>;
  /** （可选）用契约自带 examples 标定自己：坏样本必判红、好样本必判绿。 */
  selfCalibrate?(contract: Contract): Promise<CalibrationResult>;
}

/** 门禁整体结论。blocked = 没有失败，但有待人工决策，既不放行也不算失败。 */
export type GateOutcome = "pass" | "fail" | "blocked";

export interface GateReport {
  outcome: GateOutcome;
  results: CheckResult[];
  summary: { pass: number; fail: number; error: number; needsReview: number; total: number };
  /** 待人工决策的检查（reporter 会重点呈现其 decision）。 */
  pendingDecisions: CheckResult[];
  /** 退出码：0=pass，1=fail（含 error），2=blocked（待人工决策）。 */
  exitCode: number;
}

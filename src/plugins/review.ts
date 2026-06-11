import type { CheckResult, Contract, DecisionOption, DecisionRequest, Evidence, Plugin, RunContext } from "../types.js";

/**
 * review 插件：把“机器判不了的判断”交给人，并结构化地呈现决策重点。
 * 它总是返回 needs_review（除非上下文已有该 id 的人工裁决，由 GateCore 解析为 pass/fail）。
 *
 * 典型场景：冻结契约失败——是回归(该挡)，还是产品有意改行为(该更新契约)?
 *
 * 契约字段(都可选,缺省给出通用裁决)：
 *   question, focalPoints[], evidence[{label,value}], options[{id,label,resolvesTo}], recommended
 */
export const reviewPlugin: Plugin = {
  type: "review",

  async run(contract: Contract, _ctx: RunContext): Promise<CheckResult> {
    const question =
      typeof contract.question === "string"
        ? contract.question
        : `“${contract.scenario ?? contract.id}” 需要人工判断后才能放行`;

    const focalPoints = Array.isArray(contract.focalPoints)
      ? contract.focalPoints.map(String)
      : [
          "这是回归(代码破坏了不该破坏的行为),还是产品有意改变了该行为?",
          "若是有意改变:对应的冻结契约是否也该更新?(更新契约=改规则,走审批)",
          "若是回归:爆炸半径多大,是否需要立即挡回?",
        ];

    const evidence: Evidence[] = Array.isArray(contract.evidence)
      ? (contract.evidence as Evidence[])
      : [{ label: "上下文", value: String(contract.scenario ?? "(未提供)") }];

    const options: DecisionOption[] = Array.isArray(contract.options)
      ? (contract.options as DecisionOption[])
      : [
          { id: "intended", label: "有意改变行为,更新契约后放行", resolvesTo: "pass" },
          { id: "regression", label: "判定为回归,挡回去修", resolvesTo: "fail" },
        ];

    const decision: DecisionRequest = {
      question,
      focalPoints,
      evidence,
      options,
      ...(typeof contract.recommended === "string" ? { recommended: contract.recommended } : {}),
    };

    return {
      id: contract.id,
      type: this.type,
      status: "needs_review",
      durationMs: 0,
      violations: [],
      decision,
    };
  },
};

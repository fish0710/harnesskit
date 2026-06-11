import type { CheckResult, GateReport, GateOutcome, Verdict } from "./types.js";

/**
 * 把若干检查结果聚合成门禁结论。纯函数，便于元测试。
 *
 * 优先级（红线）：
 *   任何 fail 或 error  → outcome=fail, exit=1   （error 当失败，绝不放行）
 *   否则有 needs_review → outcome=blocked, exit=2 （待人工决策，不放行也不算失败）
 *   否则全 pass         → outcome=pass, exit=0
 */
export function aggregate(results: CheckResult[]): GateReport {
  const summary = { pass: 0, fail: 0, error: 0, needsReview: 0, total: results.length };
  for (const r of results) {
    if (r.status === "pass") summary.pass++;
    else if (r.status === "fail") summary.fail++;
    else if (r.status === "error") summary.error++;
    else summary.needsReview++;
  }

  const pendingDecisions = results.filter((r) => r.status === "needs_review");

  let outcome: GateOutcome;
  let exitCode: number;
  if (summary.fail > 0 || summary.error > 0) {
    outcome = "fail";
    exitCode = 1;
  } else if (summary.needsReview > 0) {
    outcome = "blocked";
    exitCode = 2;
  } else {
    outcome = "pass";
    exitCode = 0;
  }

  return { outcome, results, summary, pendingDecisions, exitCode };
}

/**
 * 用人工裁决解析一条 needs_review 结果。
 * 选项无效 → error（不可静默放行）；resolvesTo 决定最终 pass / fail。
 */
export function resolveWithVerdict(result: CheckResult, verdict: Verdict): CheckResult {
  const option = result.decision?.options.find((o) => o.id === verdict.optionId);
  if (!option) {
    return {
      ...result,
      status: "error",
      errorReason: `人工裁决选项无效: "${verdict.optionId}"（该决策不接受此选项）`,
    };
  }
  if (option.resolvesTo === "pass") {
    return { ...result, status: "pass", violations: [] };
  }
  return {
    ...result,
    status: "fail",
    violations: [
      {
        what: `人工裁决: ${option.label}`,
        why: verdict.reason ?? "(裁决未附理由)",
        how: "按裁决结果处理；若有异议走人工审批改契约/规则",
        ref: `verdict by ${verdict.by} @ ${verdict.at}`,
      },
    ],
  };
}

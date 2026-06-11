import type { CheckResult, GateReport } from "./types.js";

/** 极简 ANSI 着色（不引依赖）。无 TTY 时自动降级为无色。 */
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  green: (s: string) => paint("32", s),
  red: (s: string) => paint("31", s),
  yellow: (s: string) => paint("33", s),
  cyan: (s: string) => paint("36", s),
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
};

const badge: Record<CheckResult["status"], string> = {
  pass: c.green("✓ PASS"),
  fail: c.red("✗ FAIL"),
  error: c.yellow("⚠ ERROR"),
  needs_review: c.cyan("◐ REVIEW"),
};

const outcomeLine: Record<GateReport["outcome"], string> = {
  pass: c.green("● 门禁通过 (pass)"),
  fail: c.red("● 门禁未通过 (fail)"),
  blocked: c.cyan("● 门禁待人工决策 (blocked)"),
};

/** 人读报告。pending decisions 单独、突出地呈现“决策重点”。 */
export function renderPretty(report: GateReport): string {
  const out: string[] = [];
  const { summary } = report;

  out.push("");
  out.push(c.bold("Harness Gate Report"));
  out.push(
    c.dim(
      `检查 ${summary.total} 项 — ` +
        `${summary.pass} pass, ${summary.fail} fail, ${summary.error} error, ${summary.needsReview} review`,
    ),
  );
  out.push("");

  // 逐项简报
  for (const r of report.results) {
    out.push(`  ${badge[r.status]}  ${c.bold(r.id)} ${c.dim(`(${r.type}, ${r.durationMs.toFixed(0)}ms)`)}`);
    if (r.status === "error" && r.errorReason) {
      out.push(`        ${c.yellow("没跑成:")} ${r.errorReason}`);
    }
    for (const v of r.violations) {
      const loc = v.file ? ` ${v.file}${v.line ? ":" + v.line : ""}` : "";
      out.push(`        ${c.red("✗")}${loc} ${v.what}`);
      out.push(`          ${c.dim("原因:")} ${v.why}`);
      out.push(`          ${c.dim("修复:")} ${v.how}${v.ref ? c.dim("  · " + v.ref) : ""}`);
    }
  }

  // 决策重点：把需要人决定的事单独、突出呈现
  if (report.pendingDecisions.length > 0) {
    out.push("");
    out.push(c.cyan("─".repeat(60)));
    out.push(c.cyan(c.bold(`需要你决策 (${report.pendingDecisions.length} 项) — 机器判不了，已为你列出决策重点`)));
    out.push(c.cyan("─".repeat(60)));
    for (const r of report.pendingDecisions) {
      const d = r.decision!;
      out.push("");
      out.push(`  ${c.cyan("◐")} ${c.bold(r.id)} ${c.dim(`(${r.type})`)}`);
      out.push(`    ${c.bold("决定:")} ${d.question}`);
      if (d.focalPoints.length) {
        out.push(`    ${c.bold("决策重点:")}`);
        for (const fp of d.focalPoints) out.push(`      • ${fp}`);
      }
      if (d.evidence.length) {
        out.push(`    ${c.dim("证据:")}`);
        for (const e of d.evidence) out.push(`      ${c.dim("-")} ${e.label}: ${e.value}`);
      }
      out.push(`    ${c.bold("可选裁决:")}`);
      for (const o of d.options) {
        const tag = o.resolvesTo === "pass" ? c.green("→放行") : c.red("→挡回");
        const rec = d.recommended === o.id ? c.dim(" (建议)") : "";
        out.push(`      [${o.id}] ${o.label} ${tag}${rec}`);
      }
      out.push(`    ${c.dim(`裁决方式: 记录一个 verdict(optionId, by, reason),重跑即解析`)}`);
    }
    out.push("");
  }

  out.push("");
  out.push(`  ${outcomeLine[report.outcome]}   ${c.dim(`exit=${report.exitCode}`)}`);
  out.push("");
  return out.join("\n");
}

/** 机器读报告（给 agent / CI 解析）。 */
export function renderJson(report: GateReport): string {
  return JSON.stringify(report, null, 2);
}

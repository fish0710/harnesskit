import { loadContracts, verifyFrozen } from "../contracts.js";
import { loadVerdicts } from "./verdicts.js";
import { lastRunRecord } from "./record.js";

/** 汇总项目状态(轻量,不跑门禁)。返回可打印的行。 */
export function gatherStatus(cwd: string, contractsDir: string): string[] {
  const out: string[] = [];
  const { contracts, issues } = loadContracts(contractsDir);

  const byType: Record<string, number> = {};
  let frozen = 0;
  const tampered: string[] = [];
  for (const c of contracts) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    if (c.frozen) {
      frozen++;
      const v = verifyFrozen(c);
      if (!v.ok) tampered.push(v.message ?? c.id);
    }
  }

  out.push(`契约: ${contracts.length} 条 (` + Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(", ") + `)`);
  out.push(`冻结: ${frozen} 条` + (tampered.length ? `,⚠ 被篡改 ${tampered.length} 条` : ""));
  for (const t of tampered) out.push(`  ⚠ ${t}`);
  if (issues.length) out.push(`⚠ 契约规格问题: ${issues.length} 处(运行 harness contract validate 查看)`);

  const verdicts = loadVerdicts(cwd);
  out.push(`已记录人工裁决: ${Object.keys(verdicts).length} 条`);

  const last = lastRunRecord(cwd);
  if (last) {
    out.push(`最近一次 run: ${last.at} · task="${last.task}" · driver=${last.driver} · ${last.outcome}(${last.attempts} 轮)`);
  } else {
    out.push("最近一次 run: 无");
  }
  return out;
}

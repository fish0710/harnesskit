import { loadContracts, verifyFrozen } from "../contracts.js";
import { loadVerdicts } from "./verdicts.js";
import { lastRunRecord, RunStore, type RunRecordV3 } from "./record.js";

function latestRunForStatus(cwd: string): RunRecordV3 | undefined {
  return new RunStore(cwd).listRuns()
    .sort((a, b) => {
      const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (updated !== 0) return updated;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    })[0];
}

function formatV3Run(run: RunRecordV3): string {
  const attempts = run.attemptCount ?? run.attempts.length;
  const outcome = run.outcome ?? run.status;
  return (
    `最近一次 run: ${run.updatedAt} · kind=${run.kind} · ` +
    `task="${run.task.description}" · driver=${run.driver} · ` +
    `${run.status}/${outcome}(${attempts} 轮)`
  );
}

/** 汇总项目状态(轻量,不跑门禁)。返回可打印的行。 */
export function gatherStatus(cwd: string, contractsDir: string): string[] {
  const out: string[] = [];
  const { contracts, issues } = loadContracts(contractsDir);

  const byType: Record<string, number> = {};
  let frozen = 0;
  const verificationFailures: string[] = [];
  for (const c of contracts) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    if (c.frozen) {
      frozen++;
      const v = verifyFrozen(c);
      if (!v.ok) verificationFailures.push(v.message ?? c.id);
    }
  }

  out.push(`契约: ${contracts.length} 条 (` + Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(", ") + `)`);
  out.push(`冻结: ${frozen} 条` + (verificationFailures.length ? `,⚠ 校验失败 ${verificationFailures.length} 条` : ""));
  for (const failure of verificationFailures) out.push(`  ⚠ ${failure}`);
  if (issues.length) out.push(`⚠ 契约规格问题: ${issues.length} 处(运行 harness contract validate 查看)`);

  const verdicts = loadVerdicts(cwd);
  out.push(`已记录人工裁决: ${Object.keys(verdicts).length} 条`);

  const latest = latestRunForStatus(cwd);
  if (latest) {
    out.push(formatV3Run(latest));
  } else {
    const last = lastRunRecord(cwd);
    if (last) {
      out.push(
        `最近一次 run: ${last.at} · task="${last.task}" · ` +
        `driver=${last.driver} · ${last.outcome}(${last.attempts} 轮)`,
      );
    } else {
      out.push("最近一次 run: 无");
    }
  }
  return out;
}

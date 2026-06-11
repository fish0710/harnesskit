import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "../types.js";

const dirOf = (cwd: string) => join(cwd, ".harness");
const fileOf = (cwd: string) => join(dirOf(cwd), "verdicts.json");

/** 读取已记录的人工裁决(按契约 id)。 */
export function loadVerdicts(cwd: string): Record<string, Verdict> {
  const f = fileOf(cwd);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, Verdict>;
  } catch {
    return {};
  }
}

/** 记录一个裁决,持久化到 .harness/verdicts.json。 */
export function recordVerdict(cwd: string, contractId: string, verdict: Verdict): void {
  mkdirSync(dirOf(cwd), { recursive: true });
  const all = loadVerdicts(cwd);
  all[contractId] = verdict;
  writeFileSync(fileOf(cwd), JSON.stringify(all, null, 2), "utf8");
}

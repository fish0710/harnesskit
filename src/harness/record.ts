import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "./run.js";

const runsDir = (cwd: string) => join(cwd, ".harness", "runs");

export interface RunRecord {
  at: string;
  task: string;
  driver: string;
  outcome: RunOutcome["outcome"];
  attempts: number;
  summary: RunOutcome["report"]["summary"];
  action?: RunOutcome["action"];
}

export function writeRunRecord(cwd: string, rec: RunRecord): string {
  mkdirSync(runsDir(cwd), { recursive: true });
  const name = `${rec.at.replace(/[:.]/g, "-")}.json`;
  const path = join(runsDir(cwd), name);
  writeFileSync(path, JSON.stringify(rec, null, 2), "utf8");
  return path;
}

export function lastRunRecord(cwd: string): RunRecord | undefined {
  const d = runsDir(cwd);
  if (!existsSync(d)) return undefined;
  const files = readdirSync(d).filter((f) => f.endsWith(".json")).sort();
  const last = files[files.length - 1];
  if (!last) return undefined;
  try {
    return JSON.parse(readFileSync(join(d, last), "utf8")) as RunRecord;
  } catch {
    return undefined;
  }
}

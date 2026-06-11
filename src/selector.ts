import type { Contract } from "./types.js";

/**
 * 选择配置:决定哪些契约该跑。核心红线——基线恒选,按改动只增不减。
 *   baseline: 恒跑的契约 id(无论改动范围)
 *   rules:    when(改动路径 glob) 命中则追加 select(契约 id)
 */
export interface SelectConfig {
  baseline: string[];
  rules: Array<{ when: string[]; select: string[] }>;
}

/** 极简 glob → 正则:支持 ** (任意层) 与 * (单层内任意,不跨 /)。 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // **
        i++;
        if (glob[i + 1] === "/") i++; // 吞掉 **/ 的斜杠
      } else {
        re += "[^/]*"; // *
      }
    } else if ("\\^$+?.()|{}[]".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * 按改动文件选契约:基线 + 命中规则的契约,去重并集。绝不缩小基线。
 * 未在集合里的 id 会被忽略(只选实际存在的契约)。
 */
export function selectByChange(
  all: Contract[],
  config: SelectConfig,
  changedFiles: string[],
): { selected: Contract[]; reasons: Record<string, string> } {
  const byId = new Map(all.map((c) => [c.id, c]));
  const reasons: Record<string, string> = {};
  const ids = new Set<string>();

  // 基线恒选
  for (const id of config.baseline) {
    if (byId.has(id)) {
      ids.add(id);
      reasons[id] = "baseline(恒跑)";
    }
  }
  // 规则命中则追加(只增不减)
  for (const rule of config.rules) {
    const hit = changedFiles.find((f) => matchesAny(f, rule.when));
    if (!hit) continue;
    for (const id of rule.select) {
      if (byId.has(id) && !ids.has(id)) {
        ids.add(id);
        reasons[id] = `改动命中 ${rule.when.join("|")} → 追加(由 ${hit})`;
      }
    }
  }

  const selected = [...ids].map((id) => byId.get(id)!);
  return { selected, reasons };
}

/** 按 stage 字段选契约(需求/分析/生成/生产各自的门)。 */
export function selectByStage(all: Contract[], stage: string): Contract[] {
  return all.filter((c) => c.stage === stage);
}

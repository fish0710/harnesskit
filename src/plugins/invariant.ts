import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

/** 属性函数:对一个输入返回是否满足该不变量。 */
export type Property = (input: unknown) => boolean;

interface InvTrigger {
  generator?: "integers" | "strings" | "booleans";
  samples?: number;
  min?: number;
  max?: number;
}

function genInteger(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function genString(): string {
  const n = Math.floor(Math.random() * 12);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(32 + Math.floor(Math.random() * 95));
  return s;
}

/** 生成样本:随机 + 一批边界值(0/1/-1/min/max 等),边界最容易暴露 bug。 */
function makeSamples(t: InvTrigger): unknown[] {
  const samples = typeof t.samples === "number" ? t.samples : 200;
  const gen = t.generator ?? "integers";
  const out: unknown[] = [];
  if (gen === "integers") {
    const min = t.min ?? -1000;
    const max = t.max ?? 1000;
    out.push(0, 1, -1, 2, min, max); // 边界
    for (let i = 0; i < samples; i++) out.push(genInteger(min, max));
  } else if (gen === "strings") {
    out.push("", " ", "a");
    for (let i = 0; i < samples; i++) out.push(genString());
  } else {
    out.push(true, false);
  }
  return out;
}

/**
 * invariant 适配器(工厂):属性测试。属性是代码,故由外部注入属性函数表,
 * 契约只引用属性名——这正是"少数需自定义验证逻辑"的安全形态:
 * 你给 examples/属性,内核跑;生产可把内置生成器换成 fast-check。
 *
 *   属性名未注册 → error
 *   找到反例     → fail(附反例)
 *   全部通过     → pass
 *
 * 契约:{ type:"invariant", property:"<name>", trigger:{generator,samples,min,max} }
 */
export function createInvariantPlugin(properties: Record<string, Property>): Plugin {
  return {
    type: "invariant",
    async run(c: Contract, _ctx: RunContext): Promise<CheckResult> {
      const name = String(c.property ?? "");
      const prop = properties[name];
      if (!prop) {
        return { id: c.id, type: this.type, status: "error", durationMs: 0, violations: [],
          errorReason: `属性 "${name}" 未注册(可用: [${Object.keys(properties).join(", ") || "无"}])⇒ error` };
      }
      const t = (c.trigger ?? {}) as InvTrigger;
      const samples = makeSamples(t);
      const start = performance.now();
      for (const input of samples) {
        let ok: boolean;
        try {
          ok = prop(input);
        } catch (err) {
          // 属性在某输入上抛异常 = 找到一个会崩的反例 ⇒ fail
          return {
            id: c.id, type: this.type, status: "fail", durationMs: performance.now() - start,
            violations: [{
              what: `属性 "${name}" 在输入 ${JSON.stringify(input)} 上抛异常: ${err instanceof Error ? err.message : String(err)}`,
              why: c.scenario ? String(c.scenario) : "不变量被违反(异常)",
              how: "处理该输入,或修正实现使其满足不变量",
            }],
          };
        }
        if (!ok) {
          return {
            id: c.id, type: this.type, status: "fail", durationMs: performance.now() - start,
            violations: [{
              what: `属性 "${name}" 反例: 输入 ${JSON.stringify(input)} 不满足`,
              why: c.scenario ? String(c.scenario) : "不变量被违反",
              how: "修正实现使其对该输入也满足不变量",
            }],
          };
        }
      }
      return { id: c.id, type: this.type, status: "pass", durationMs: performance.now() - start, violations: [] };
    },
  };
}

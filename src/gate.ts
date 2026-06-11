import type { Contract, CheckResult, GateReport, Plugin, RunContext } from "./types.js";
import { PluginRegistry } from "./registry.js";
import { aggregate, resolveWithVerdict } from "./aggregate.js";

/**
 * 门禁内核。职责：按 type 把契约派给插件、执行、聚合。
 * 它不做任何业务判定——判定在插件里，结论由 aggregate 机械得出。
 */
export class GateCore {
  constructor(private readonly registry: PluginRegistry = new PluginRegistry()) {}

  /** 注册一个插件（扩展点）。链式调用。 */
  use(plugin: Plugin): this {
    this.registry.register(plugin);
    return this;
  }

  /** 已注册的插件 type 列表。 */
  plugins(): string[] {
    return this.registry.list();
  }

  /** 跑一组契约，得到门禁报告。 */
  async run(contracts: Contract[], ctx: RunContext): Promise<GateReport> {
    const results: CheckResult[] = [];

    for (const contract of contracts) {
      const plugin = this.registry.get(contract.type);

      // 红线：没有插件能处理这个 type ⇒ error，绝不静默当通过。
      if (!plugin) {
        results.push({
          id: contract.id,
          type: contract.type,
          status: "error",
          durationMs: 0,
          violations: [],
          errorReason:
            `没有注册处理 type="${contract.type}" 的插件，无法验证此契约 ⇒ 判 error（绝不当通过）。` +
            `已注册: [${this.registry.list().join(", ") || "无"}]`,
        });
        continue;
      }

      const start = performance.now();
      try {
        let result = await plugin.run(contract, ctx);
        result.durationMs = result.durationMs || performance.now() - start;

        // 若是 needs_review 且已有人工裁决，就地解析为 pass/fail。
        if (result.status === "needs_review") {
          const verdict = ctx.verdicts?.[contract.id];
          if (verdict) result = resolveWithVerdict(result, verdict);
        }
        results.push(result);
      } catch (err) {
        // 插件自身抛异常 = 没跑成 = error（不可当通过）。
        results.push({
          id: contract.id,
          type: contract.type,
          status: "error",
          durationMs: performance.now() - start,
          violations: [],
          errorReason: `插件执行抛异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return aggregate(results);
  }

  /**
   * 元测试入口：让每个能 selfCalibrate 的插件，用契约自带 examples 标定自己。
   * 任何插件标定失败 ⇒ 整体失败（“先证明门禁自己没瞎，再用它判代码”）。
   */
  async calibrate(contracts: Contract[]): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = [];
    let ok = true;
    for (const contract of contracts) {
      const plugin = this.registry.get(contract.type);
      if (!plugin?.selfCalibrate) continue;
      const res = await plugin.selfCalibrate(contract);
      if (!res.ok) ok = false;
      lines.push(`[${res.ok ? "OK" : "FAIL"}] ${contract.id}: ${res.details.join("; ")}`);
    }
    return { ok, lines };
  }
}

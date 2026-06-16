import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

export const miniprogramPlugin: Plugin = {
  type: "miniprogram",

  async run(contract: Contract, _ctx: RunContext): Promise<CheckResult> {
    return {
      id: contract.id,
      type: this.type,
      status: "error",
      durationMs: 0,
      violations: [],
      errorReason: "miniprogram 插件尚未实现执行逻辑",
    };
  },
};

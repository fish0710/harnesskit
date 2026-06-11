import { executionId, localExecutionTarget } from "../harness/execution.js";
import type { CheckResult, Contract, Plugin, RunContext } from "../types.js";

interface HttpTrigger {
  method?: string;
  url?: string;        // 完整 URL,或用 baseUrl + path
  baseUrl?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}
interface HttpExpect {
  status?: number;
  body_contains?: Record<string, unknown> | string; // JSON 字段子集,或子串
  headers?: Record<string, string>;
}

function resolveUrl(t: HttpTrigger, ctx: RunContext): string | undefined {
  if (t.url) return t.url;
  const base = t.baseUrl ?? (ctx as { baseUrl?: string }).baseUrl;
  if (base && t.path) return base.replace(/\/$/, "") + t.path;
  return undefined;
}

function checkBody(actual: string, expect: Record<string, unknown> | string): string[] {
  if (typeof expect === "string") {
    return actual.includes(expect) ? [] : [`响应体不含子串 "${expect}"`];
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(actual) as Record<string, unknown>;
  } catch {
    return ["响应体非 JSON,无法做字段断言"];
  }
  const fails: string[] = [];
  for (const [k, v] of Object.entries(expect)) {
    if (JSON.stringify(json[k]) !== JSON.stringify(v)) {
      fails.push(`字段 "${k}" 期望 ${JSON.stringify(v)},实际 ${JSON.stringify(json[k])}`);
    }
  }
  return fails;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

/**
 * http 适配器:黑盒打接口,断言可观测结果(状态码/响应体/响应头)。语言无关。
 *   连不上/超时 → error(没跑成,不是 fail)
 *   断言不符    → fail
 *   断言全符    → pass
 *
 * 契约:{ type:"http", trigger:{method,url|baseUrl+path,headers?,body?}, expect:{status?,body_contains?,headers?} }
 */
export const httpPlugin: Plugin = {
  type: "http",

  async run(c: Contract, ctx: RunContext): Promise<CheckResult> {
    const t = (c.trigger ?? {}) as HttpTrigger;
    const e = (c.expect ?? {}) as HttpExpect;
    const url = resolveUrl(t, ctx);
    if (!url) {
      return { id: c.id, type: this.type, status: "error", durationMs: 0, violations: [],
        errorReason: "无法解析请求 URL(请给 trigger.url,或 baseUrl+path)⇒ error" };
    }

    const id = executionId();
    const evidence = await (ctx.execution ?? localExecutionTarget).request({
      executionId: id,
      url,
      method: t.method ?? "GET",
      headers: t.headers,
      body: t.body !== undefined ? JSON.stringify(t.body) : undefined,
      timeoutMs: t.timeoutMs,
      signal: ctx.signal,
    });
    const durationMs = evidence.durationMs;

    if (evidence.executionId !== id) {
      return { id: c.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: "执行证据 ID 不匹配，结果不可信 ⇒ error" };
    }
    if (evidence.error) {
      // 连不上/超时 = 服务没起来或网络问题 = 没跑成 ⇒ error
      return { id: c.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: `请求失败(连不上/超时): ${evidence.error} ⇒ error` };
    }
    if (evidence.status === undefined) {
      return { id: c.id, type: this.type, status: "error", durationMs, violations: [],
        errorReason: "HTTP 执行证据缺少状态码，结果不可信 ⇒ error" };
    }

    const fails: string[] = [];

    if (e.status !== undefined && evidence.status !== e.status) {
      fails.push(`状态码期望 ${e.status},实际 ${evidence.status}`);
    }
    if (e.body_contains !== undefined) fails.push(...checkBody(evidence.body, e.body_contains));
    if (e.headers) {
      for (const [k, v] of Object.entries(e.headers)) {
        const got = headerValue(evidence.headers, k);
        if (got !== v) fails.push(`响应头 "${k}" 期望 ${v},实际 ${got ?? "(无)"}`);
      }
    }

    if (fails.length === 0) {
      return { id: c.id, type: this.type, status: "pass", durationMs, violations: [] };
    }
    return {
      id: c.id, type: this.type, status: "fail", durationMs,
      violations: fails.map((f) => ({
        what: f,
        why: c.scenario ? String(c.scenario) : "HTTP 行为未达契约",
        how: `检查 ${t.method ?? "GET"} ${t.path ?? url} 的实现`,
        ref: typeof c.ref === "string" ? c.ref : undefined,
      })),
    };
  },
};

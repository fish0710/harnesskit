import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import type { Contract } from "./types.js";

export interface ValidationIssue {
  file?: string;
  contractId?: string;
  message: string;
}

export interface LoadResult {
  contracts: Contract[];
  issues: ValidationIssue[]; // 契约规格本身的问题(语法/必填缺失)——CLI 应视为 error
}

/** 每个 type 的必填字段。新增插件时在这里登记其 schema 要求。 */
const REQUIRED_BY_TYPE: Record<string, string[]> = {
  command: ["cmd"],
  boot: ["cmd"],
  http: ["trigger"],
  structure: ["tool"],
  invariant: ["property"],
  miniprogram: ["projectPath", "runner"],
  review: [], // review 宽松:缺省给通用裁决
};

/** 校验单个契约的外壳 + type 专属必填。返回问题列表(空=通过)。 */
export function validateContract(c: unknown, file?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof c !== "object" || c === null) {
    return [{ file, message: "契约不是对象" }];
  }
  const obj = c as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  if (!id) issues.push({ file, message: "缺少 id(字符串)" });
  const type = typeof obj.type === "string" ? obj.type : undefined;
  if (!type) {
    issues.push({ file, contractId: id, message: "缺少 type(字符串)" });
    return issues;
  }
  const required = REQUIRED_BY_TYPE[type];
  // 注意:未知 type 不在这里报错——是否有插件处理它,由 GateCore 在运行时判 error。
  // 这里只校验“已知 type 的必填字段”。
  if (required) {
    for (const field of required) {
      if (obj[field] === undefined) {
        issues.push({ file, contractId: id, message: `type="${type}" 缺少必填字段 "${field}"` });
      }
    }
  }
  return issues;
}

/** 从目录递归加载契约(.yaml/.yml/.json),校验并返回。 */
export function loadContracts(dir: string): LoadResult {
  const contracts: Contract[] = [];
  const issues: ValidationIssue[] = [];

  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (e) {
      issues.push({ file: d, message: `无法读取目录: ${(e as Error).message}` });
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (![".yaml", ".yml", ".json"].includes(ext)) continue;

      let parsed: unknown;
      try {
        const text = readFileSync(full, "utf8");
        parsed = ext === ".json" ? JSON.parse(text) : yaml.load(text);
      } catch (e) {
        issues.push({ file: full, message: `解析失败: ${(e as Error).message}` });
        continue;
      }
      // 一个文件可含单个契约或契约数组
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const v = validateContract(item, full);
        if (v.length) {
          issues.push(...v);
          continue; // 规格无效的契约不进集合(避免被静默忽略=被当通过)
        }
        contracts.push(item as Contract);
      }
    }
  };

  walk(dir);
  return { contracts, issues };
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };
const FROZEN_HASH_VERSION = "v2";

function canonicalize(value: unknown, seen = new WeakSet<object>()): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Cannot canonicalize a circular structure");
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cannot canonicalize a non-plain object");
    }

    const entries: [string, CanonicalJson][] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) entries.push([key, canonicalize(item, seen)]);
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

/** 计算契约内容哈希(排除 frozen/frozen_at/hash 自身),用于冻结与防篡改。 */
export function contractHash(c: Contract): string {
  const { frozen, frozen_at, hash, ...rest } = c as Record<string, unknown>;
  void frozen; void frozen_at; void hash;
  const canonical = JSON.stringify(canonicalize(rest));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 冻结一个契约:打标 frozen、记录时间与内容哈希。 */
export function freezeContract(c: Contract): Contract {
  return {
    ...c,
    frozen: true,
    frozen_at: new Date().toISOString(),
    hash: `${FROZEN_HASH_VERSION}:${contractHash(c)}`,
  };
}

/** 校验一个已冻结契约的哈希格式与内容。 */
export function verifyFrozen(c: Contract): { ok: boolean; message?: string } {
  if (!c.frozen) return { ok: true };
  const expected = typeof c.hash === "string" ? c.hash : undefined;
  if (!expected) return { ok: false, message: `契约 ${c.id} 标记 frozen 但缺少 hash` };
  const [version, digest, ...extra] = expected.split(":");
  if (version !== FROZEN_HASH_VERSION || !digest || extra.length > 0 || !/^[0-9a-f]{16}$/.test(digest)) {
    return {
      ok: false,
      message: `契约 ${c.id} 使用旧版或不支持的冻结哈希格式,必须重新冻结`,
    };
  }

  try {
    const actual = contractHash(c);
    return actual === digest
      ? { ok: true }
      : { ok: false, message: `契约 ${c.id} 内容与冻结哈希不符(疑似被改:期望 ${digest},实际 ${actual})` };
  } catch (error) {
    return {
      ok: false,
      message: `契约 ${c.id} 无法计算哈希或完成校验: ${(error as Error).message}`,
    };
  }
}

import type { Plugin } from "./types.js";

/**
 * 插件注册表 —— 扩展点的载体。
 * 按 type 注册；重复注册同一 type 直接报错（避免静默覆盖判定逻辑）。
 */
export class PluginRegistry {
  private readonly map = new Map<string, Plugin>();

  register(plugin: Plugin): this {
    if (this.map.has(plugin.type)) {
      throw new Error(`插件 type 已注册，拒绝覆盖: "${plugin.type}"`);
    }
    this.map.set(plugin.type, plugin);
    return this;
  }

  get(type: string): Plugin | undefined {
    return this.map.get(type);
  }

  has(type: string): boolean {
    return this.map.has(type);
  }

  list(): string[] {
    return [...this.map.keys()].sort();
  }
}

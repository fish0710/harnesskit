/**
 * Claude Agent SDK 的最小 ambient 声明 —— 让 runner 在“未安装 SDK”时也能编译。
 * 运行时通过动态 import 真正加载(需 `npm i @anthropic-ai/claude-agent-sdk` + API key)。
 * 真实形状以官方 SDK 为准;这里只声明 runner 用到的子集。
 */
declare module "@anthropic-ai/claude-agent-sdk" {
  export type HookCallback = (
    input: unknown,
    toolUseID: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<Record<string, unknown>>;

  export interface HookCallbackMatcher {
    matcher?: string;
    hooks: HookCallback[];
    timeout?: number;
  }

  export interface QueryOptions {
    cwd?: string;
    allowedTools?: string[];
    mcpServers?: Record<string, unknown>;
    hooks?: Record<string, HookCallbackMatcher[]>;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
    [k: string]: unknown;
  }
  export interface QueryParams {
    prompt: string;
    options?: QueryOptions;
  }
  export function query(params: QueryParams): AsyncIterable<unknown>;
}

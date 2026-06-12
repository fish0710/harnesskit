import { spawnCapture } from "../util/spawn.js";
import {
  startLangfuseObservability,
  type ClaudeSdkModule,
  type StartLangfuseOptions,
} from "./langfuse.js";

/**
 * Agent driver —— “产出”这一步的可插拔接缝。
 * runLoop 负责迭代/升级;driver 只负责“做一次修改尝试”(在 cwd 上)。
 * 这样默认 scaffold driver 能让整条链路空跑跑通,真实产出靠换 driver。
 */
export interface AgentTaskInput {
  task: string;
  cwd: string;
  feedback?: string; // 上一轮门禁诊断,回喂 agent
}
export interface AgentTaskResult {
  summary: string;
  changedFiles: string[];
}
export interface AgentDriver {
  readonly name: string;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  close?(): Promise<void>;
}

export type AgentSpec =
  | { kind: "scaffold" }
  | { kind: "claude" }
  | { kind: "command"; command: string };

export function selectAgent(values: Record<string, unknown>): AgentSpec {
  const kind = (values.driver as string | undefined) ?? "scaffold";
  if (kind === "command") {
    const command = values["agent-cmd"];
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("--driver command 需要 --agent-cmd");
    }
    return { kind: "command", command };
  }
  if (kind === "claude") return { kind: "claude" };
  if (kind === "scaffold") return { kind: "scaffold" };
  throw new Error(`未知 driver: ${kind}`);
}

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export interface ClaudeDriverOptions {
  allowedTools?: string[];
  permissionMode?: ClaudePermissionMode;
  mcpServers?: Record<string, unknown>;
  onObservation?: (event: string, data: unknown) => void;
  dependencies?: ClaudeDriverDependencies;
}

export interface ClaudeDriverDependencies {
  loadClaudeSdk(): Promise<ClaudeSdkModule>;
  startObservability(options: StartLangfuseOptions): ReturnType<typeof startLangfuseObservability>;
}

export function buildClaudeQueryOptions(opts: ClaudeDriverOptions = {}) {
  const observeHook = (event: string) =>
    async (
      input: unknown,
      _toolUseId: string | undefined,
      _hookOptions: { signal: AbortSignal },
    ) => {
      opts.onObservation?.(event, input);
      return {};
    };

  return {
    allowedTools: opts.allowedTools ?? ["Bash", "Edit", "Write"],
    permissionMode: opts.permissionMode ?? "dontAsk",
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    hooks: {
      PreToolUse: [{ hooks: [observeHook("PreToolUse")] }],
      PostToolUse: [{ hooks: [observeHook("PostToolUse")] }],
      Stop: [{ hooks: [observeHook("Stop")] }],
    },
  };
}

/**
 * 默认 driver:不调任何模型,空跑一轮。
 * 让 run→gate→反馈→升级 链路现在就能跑通,并明确提示“此处接真实 driver”。
 */
export const scaffoldDriver: AgentDriver = {
  name: "scaffold",
  async runTask(): Promise<AgentTaskResult> {
    return {
      summary: "DRY RUN:未产出代码。接入真实 driver(--driver claude 或 --driver command)后,agent 会在此实现并据门禁反馈迭代修复。",
      changedFiles: [],
    };
  },
};

/**
 * 通用 driver:把任务交给你自己的 agent 命令(脚本/二进制),它应修改 cwd。
 * 任务与反馈通过环境变量传入:HARNESS_TASK / HARNESS_FEEDBACK。
 */
export function commandDriver(cmd: string, args: string[] = []): AgentDriver {
  return {
    name: `command(${cmd})`,
    async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
      const res = await spawnCapture(cmd, args, {
        cwd: input.cwd,
        env: { ...process.env, HARNESS_TASK: input.task, HARNESS_FEEDBACK: input.feedback ?? "" },
      });
      if (res.spawnError) {
        return { summary: `agent 命令无法启动: ${res.spawnError}`, changedFiles: [] };
      }
      return {
        summary: `agent 命令退出码 ${res.code}` + (res.stdout.trim() ? ` · ${res.stdout.trim().split("\n").slice(-1)[0]}` : ""),
        changedFiles: [],
      };
    },
  };
}

/**
 * Claude Agent SDK driver:做一次 agent 回合(布置 cwd/hooks,全行为可观测)。
 * 需 `npm i @anthropic-ai/claude-agent-sdk` + API key;SDK 运行时动态加载。
 */
export function claudeDriver(opts: ClaudeDriverOptions = {}): AgentDriver {
  const dependencies: ClaudeDriverDependencies = opts.dependencies ?? {
    async loadClaudeSdk() {
      return { ...await import("@anthropic-ai/claude-agent-sdk") } as unknown as ClaudeSdkModule;
    },
    startObservability: startLangfuseObservability,
  };
  let observabilityPromise: ReturnType<typeof startLangfuseObservability> | undefined;
  let closed = false;

  const getObservability = () => {
    if (closed) throw new Error("Claude driver 已关闭，不能继续执行任务");
    observabilityPromise ??= dependencies.loadClaudeSdk().then((claudeSdk) =>
      dependencies.startObservability({
        claudeSdk,
        onWarning: (message) => opts.onObservation?.("warning", message),
      }),
    );
    return observabilityPromise;
  };

  return {
    name: "claude",
    async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
      const observability = await getObservability();
      const prompt = input.feedback
        ? `${input.task}\n\n[门禁反馈,请据此修复]\n${input.feedback}`
        : input.task;
      const run = observability.claudeSdk.query({
        prompt,
        options: {
          cwd: input.cwd,
          ...buildClaudeQueryOptions(opts),
        },
      });
      let turns = 0;
      for await (const m of run) {
        turns++;
        opts.onObservation?.("message", m);
      }
      return { summary: `claude 完成一轮(${turns} 条消息)`, changedFiles: [] };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!observabilityPromise) return;
      const observability = await observabilityPromise;
      await observability.shutdown();
    },
  };
}

/** @deprecated Host execution is unsafe for mutating agent work. */
export const unsafeLocalClaudeDriver = claudeDriver;

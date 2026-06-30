import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { GateCore } from "../src/gate.js";
import { commandPlugin } from "../src/plugins/command.js";
import {
  buildClaudeCommand,
  CLAUDE_COMMAND,
} from "../src/harness/sandbox/daytona.js";
import {
  createDaytonaRunEnvironment,
} from "../src/harness/sandbox/environment.js";
import { loadDaytonaObservabilityConfig } from "../src/harness/observability.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import {
  CLAUDE_TOOLCHAIN_PREFLIGHT,
} from "../src/harness/sandbox/toolchain.js";
import { workspaceFile } from "../src/harness/sandbox/workspace.js";
import type {
  SandboxCreateRequest,
  SandboxHandle,
  SandboxProvider,
  WorkspaceFile,
} from "../src/harness/sandbox/types.js";
import { runLoop, type GenerationBudget } from "../src/harness/run.js";
import type { Plugin } from "../src/types.js";

const budget: GenerationBudget = {
  maxAttempts: 3,
  maxTokens: 1e9,
  maxMs: 60_000,
  contextThreshold: 0.99,
  repeatWallThreshold: 99,
};

const modelEnvironment = {
  ANTHROPIC_AUTH_TOKEN: "test-token",
  ANTHROPIC_BASE_URL: "https://model.example.test",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
  ANTHROPIC_MODEL: "sonnet",
  ANTHROPIC_REASONING_MODEL: "reasoning",
};

const configuredClaudeEnvironment = {
  ...modelEnvironment,
  HARNESS_DAYTONA_AGENT_SNAPSHOT: "harness-agent-claude-2.1.145-r1",
  HARNESS_DAYTONA_GATE_SNAPSHOT: "harness-gate-runtime-latest",
};

function createGitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-daytona-environment-"));
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.invalid",
      "commit", "-m", "fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

function policy(setup: {
  agentSetup?: string[];
  gateSetup?: string[];
} = {}) {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      ...setup,
    },
  });
}

function retainingPolicy() {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
      retainOnFailure: true,
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 250,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

interface ScriptedProvider extends SandboxProvider {
  requests: SandboxCreateRequest[];
  handles: RecordingHandle[];
  attachHandle?: RecordingHandle;
  attachedIds: string[];
  agentPrompts: string[];
  readonly claudeRuns: number;
  createAttachedAgent(id: string): RecordingHandle;
  agentFiles(): Map<string, WorkspaceFile>;
}

class RecordingHandle implements SandboxHandle {
  readonly files = new Map<string, WorkspaceFile>();
  readonly commands: string[] = [];
  readonly executeCalls: Array<{
    command: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number | undefined;
  }> = [];
  readonly ptyCommands: string[] = [];
  readonly networkBlocks: boolean[] = [];
  verifications = 0;
  deleted = 0;

  constructor(
    readonly id: string,
    readonly role: "agent" | "gate",
    private readonly provider: {
      candidateVersions: string[];
      gateExitCodes: number[];
      claudeStdouts: string[];
      agentPrompts: string[];
      agentRuns: number;
      claudeRuns: number;
      gateRuns: number;
      agentStdout: string;
      candidateMutations: Array<
        ((files: Map<string, WorkspaceFile>) => void) | undefined
      >;
      gateDeleteFails: boolean;
      mutateProtectedOnGate: boolean;
      commandExitCodes: Record<string, number>;
      throwCommands: Record<string, Error>;
      claudeRunHooks: Array<
        ((handle: RecordingHandle, env: Record<string, string>) => Promise<void>)
          | undefined
      >;
      readFileHook?: (
        handle: RecordingHandle,
        path: string,
      ) => Promise<void>;
    },
  ) {}

  async upload(files: WorkspaceFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(
        file.path,
        workspaceFile(file.path, file.content, file.executable),
      );
    }
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) this.files.delete(path);
  }

  async verify(files: WorkspaceFile[]): Promise<void> {
    this.verifications++;
    for (const expected of files) {
      const actual = this.files.get(expected.path);
      if (
        !actual ||
        actual.sha256 !== expected.sha256 ||
        actual.executable !== expected.executable ||
        !actual.content.equals(expected.content)
      ) {
        throw new Error(
          `Host-controlled file changed: ${expected.path}`,
        );
      }
    }
  }

  workspace() {
    return {
      list: async () =>
        [...this.files.values()]
          .filter((file) => !file.path.startsWith("/"))
          .map((file) => ({
            path: file.path,
            kind: "file" as const,
            size: file.content.byteLength,
            executable: file.executable,
          })),
      read: async (path: string) => {
        const file = this.files.get(path);
        if (!file) throw new Error(`missing fake file: ${path}`);
        return Buffer.from(file.content);
      },
    };
  }

  async execute(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
    timeoutMs?: number,
  ) {
    this.commands.push(command);
    this.executeCalls.push({ command, cwd, env, timeoutMs });
    const configuredError = this.provider.throwCommands[command];
    if (configuredError) throw configuredError;
    if (command === CLAUDE_TOOLCHAIN_PREFLIGHT) {
      return {
        exitCode: 0,
        stdout:
          "node=v22.14.0\nnpm=10.9.2\nnpx=10.9.2\n" +
          "claude=2.1.145 (Claude Code)\nbash=/usr/bin/bash\n",
        stderr: "",
      };
    }
    if (this.role === "gate" && command === "assert-candidate-visible") {
      const candidate = this.files.get("src/a.ts")?.content.toString();
      return {
        exitCode: candidate === "fixed\n" ? 0 : 42,
        stdout: candidate ?? "(missing)",
        stderr: candidate === "fixed\n"
          ? ""
          : `expected candidate content, got ${JSON.stringify(candidate)}`,
      };
    }
    const configuredExitCode = this.provider.commandExitCodes[command];
    if (configuredExitCode !== undefined) {
      return {
        exitCode: configuredExitCode,
        stdout: "",
        stderr: configuredExitCode === 0 ? "" : `${command}: not found`,
      };
    }
    if (this.role === "agent" && command === "fake-agent") {
      this.provider.agentPrompts.push(env.HARNESS_FEEDBACK ?? "");
      const content = this.provider.candidateVersions[
        this.provider.agentRuns++
      ] ?? "fixed\n";
      this.files.set(
        "src/a.ts",
        workspaceFile("src/a.ts", Buffer.from(content), false),
      );
      this.provider.candidateMutations[this.provider.agentRuns - 1]?.(
        this.files,
      );
      return {
        exitCode: 0,
        stdout: this.provider.agentStdout,
        stderr: "",
      };
    }
    if (this.role === "agent" && command.includes("/usr/local/bin/claude")) {
      if (
        env.HARNESS_CLAUDE_SESSION_ID &&
        command.includes(env.HARNESS_CLAUDE_SESSION_ID)
      ) {
        throw new Error("Raw Claude session id must not be interpolated into command text");
      }
      this.provider.agentPrompts.push(env.HARNESS_PROMPT ?? "");
      const run = this.provider.claudeRuns++;
      const content = this.provider.candidateVersions[run] ?? "fixed\n";
      this.files.set(
        "src/a.ts",
        workspaceFile("src/a.ts", Buffer.from(content), false),
      );
      this.provider.candidateMutations[run]?.(this.files);
      const stdout = this.provider.claudeStdouts[run] ??
        this.provider.claudeStdouts.at(-1) ?? "";
      if (typeof env.HARNESS_CLAUDE_STREAM_PATH === "string") {
        this.files.set(
          env.HARNESS_CLAUDE_STREAM_PATH,
          workspaceFile(
            env.HARNESS_CLAUDE_STREAM_PATH,
            Buffer.from(stdout),
            false,
          ),
        );
      }
      await this.provider.claudeRunHooks[run]?.(this, env);
      return {
        exitCode: 0,
        stdout,
        stderr: "",
      };
    }
    if (
      this.role === "agent" &&
      typeof env.HARNESS_CLAUDE_STREAM_TMP === "string" &&
      typeof env.HARNESS_CLAUDE_STREAM_PATH === "string"
    ) {
      const tempPath = env.HARNESS_CLAUDE_STREAM_TMP.replace(
        /^\/workspace\/candidate\//,
        "",
      );
      const tempFile = this.files.get(tempPath);
      if (!tempFile) {
        return { exitCode: 1, stdout: "", stderr: "missing stream temp file" };
      }
      this.files.set(
        env.HARNESS_CLAUDE_STREAM_PATH,
        workspaceFile(
          env.HARNESS_CLAUDE_STREAM_PATH,
          tempFile.content,
          false,
        ),
      );
      this.files.delete(tempPath);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (this.role === "gate" && command.includes("/usr/bin/env")) {
      const exitCode = this.provider.gateExitCodes[
        this.provider.gateRuns++
      ] ?? 0;
      if (this.provider.mutateProtectedOnGate) {
        this.files.set(
          "contracts/gate.yaml",
          workspaceFile(
            "contracts/gate.yaml",
            Buffer.from("tampered\n"),
            false,
          ),
        );
      }
      return {
        exitCode,
        stdout: exitCode === 0 ? "pass" : "trusted test failed",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async runPty(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
  ) {
    this.ptyCommands.push(command);
    return this.execute(command, cwd, env);
  }

  async readFile(path: string): Promise<Buffer> {
    await this.provider.readFileHook?.(this, path);
    const file = this.files.get(path);
    if (!file) throw new Error(`missing fake file: ${path}`);
    return Buffer.from(file.content);
  }

  async setNetworkBlocked(blocked: boolean): Promise<void> {
    this.networkBlocks.push(blocked);
  }

  async delete(): Promise<void> {
    if (this.role === "gate" && this.provider.gateDeleteFails) {
      throw new Error("injected gate cleanup failure");
    }
    this.deleted++;
  }
}

function scriptedProvider(options: {
  candidateVersions: string[];
  gateExitCodes: number[];
  claudeStdouts?: string[];
  agentStdout?: string;
  candidateMutations?: Array<
    ((files: Map<string, WorkspaceFile>) => void) | undefined
  >;
  claudeRunHooks?: Array<
    ((handle: RecordingHandle, env: Record<string, string>) => Promise<void>)
      | undefined
  >;
  readFileHook?: (
    handle: RecordingHandle,
    path: string,
  ) => Promise<void>;
  gateDeleteFails?: boolean;
  mutateProtectedOnGate?: boolean;
  commandExitCodes?: Record<string, number>;
  throwCommands?: Record<string, Error>;
  attachHandle?: RecordingHandle;
}): ScriptedProvider {
  const state = {
    ...options,
    claudeStdouts: options.claudeStdouts ?? [
      JSON.stringify({ type: "result", session_id: "session-1" }),
    ],
    agentStdout: options.agentStdout ?? "agent done",
    candidateMutations: options.candidateMutations ?? [],
    claudeRunHooks: options.claudeRunHooks ?? [],
    readFileHook: options.readFileHook,
    gateDeleteFails: options.gateDeleteFails ?? false,
    mutateProtectedOnGate: options.mutateProtectedOnGate ?? false,
    commandExitCodes: options.commandExitCodes ?? {},
    throwCommands: options.throwCommands ?? {},
    agentPrompts: [] as string[],
    agentRuns: 0,
    claudeRuns: 0,
    gateRuns: 0,
  };
  const requests: SandboxCreateRequest[] = [];
  const handles: RecordingHandle[] = [];
  const attachedIds: string[] = [];
  return {
    requests,
    handles,
    attachHandle: options.attachHandle,
    attachedIds,
    agentPrompts: state.agentPrompts,
    get claudeRuns() {
      return state.claudeRuns;
    },
    async create(request) {
      requests.push(request);
      const handle = new RecordingHandle(
        `${request.role}-${handles.length + 1}`,
        request.role,
        state,
      );
      handles.push(handle);
      return handle;
    },
    async attach(id) {
      attachedIds.push(id);
      if (!this.attachHandle) throw new Error(`missing retained handle: ${id}`);
      if (!handles.includes(this.attachHandle)) {
        handles.push(this.attachHandle);
      }
      return this.attachHandle;
    },
    createAttachedAgent(id) {
      const handle = new RecordingHandle(id, "agent", state);
      this.attachHandle = handle;
      handles.push(handle);
      return handle;
    },
    agentFiles() {
      const agent = handles.find((handle) => handle.role === "agent");
      if (!agent) throw new Error("agent not created");
      return agent.files;
    },
  };
}

test("multiple attempts reuse one agent and create a fresh gate each time", async () => {
  const root = createGitFixture({
    "AGENTS.md": "repo map\n",
    "docs/specs/task.md": "task context\n",
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [1, 0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{
      id: "trusted",
      type: "command",
      cmd: "node",
      args: ["trusted-test.js"],
    }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(
    provider.requests.filter((request) => request.role === "agent").length,
    1,
  );
  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    2,
  );
  assert.equal(provider.agentPrompts.length, 2);
  assert.match(provider.agentPrompts[1]!, /trusted|退出码|failed/i);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "fixed\n");
  assert.ok(
    provider.handles
      .filter((handle) => handle.role === "gate")
      .every((handle) => handle.networkBlocks.includes(true)),
  );
  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  const gates = provider.handles.filter((handle) => handle.role === "gate");
  assert.equal(agent.files.has("contracts/gate.yaml"), false);
  assert.equal(agent.files.get("AGENTS.md")?.content.toString(), "repo map\n");
  assert.equal(
    agent.files.get("docs/specs/task.md")?.content.toString(),
    "task context\n",
  );
  assert.equal(gates[0]?.files.has(".git/HEAD"), false);
  assert.equal(
    gates[0]?.files.get("contracts/gate.yaml")?.content.toString(),
    "trusted\n",
  );
  assert.equal(gates[0]?.files.get("AGENTS.md")?.content.toString(), "repo map\n");
  assert.equal(
    gates[0]?.files.get("docs/specs/task.md")?.content.toString(),
    "task context\n",
  );
  assert.ok(gates.every((handle) => handle.verifications === 2));
});

test("Daytona gate observations use explicit logical attempt", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [0],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    attempt: 0,
  });
  await environment.close();

  const gateRunStart = observations.find(([event]) =>
    event === "gate.run.start"
  );
  const gateRunEnd = observations.find(([event]) => event === "gate.run.end");
  assert.equal((gateRunStart?.[1] as { attempt?: number }).attempt, 0);
  assert.equal((gateRunEnd?.[1] as { attempt?: number }).attempt, 0);
});

test("gate sandboxes use Gate runtime snapshots without model credentials or Claude installation", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
  });

  await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  const gateRequest = provider.requests.find(
    (request) => request.role === "gate",
  );
  const agentRequest = provider.requests.find(
    (request) => request.role === "agent",
  );
  const gateHandle = provider.handles.find(
    (handle) => handle.role === "gate",
  );
  assert.equal(
    agentRequest?.snapshot,
    configuredClaudeEnvironment.HARNESS_DAYTONA_AGENT_SNAPSHOT,
  );
  assert.equal(
    gateRequest?.snapshot,
    configuredClaudeEnvironment.HARNESS_DAYTONA_GATE_SNAPSHOT,
  );
  assert.deepEqual(gateRequest?.envVars, {});
  assert.equal(
    gateHandle?.commands.some((command) => command.includes("claude")),
    false,
  );
  const agentHandle = provider.handles.find(
    (handle) => handle.role === "agent",
  );
  const agentCommands = [
    ...(agentHandle?.commands ?? []),
    ...(agentHandle?.ptyCommands ?? []),
  ];
  assert.equal(
    agentCommands.some((command) =>
      command.includes("@anthropic-ai/claude-code")
    ),
    false,
  );
  assert.equal(
    agentCommands.some((command) => command.includes("npm install -g")),
    false,
  );
});

test("Claude Daytona observability snapshots the Agent home .claude without mounting it", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-obs",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });
  await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });
  await environment.close();

  const agentRequest = provider.requests.find(
    (request) => request.role === "agent",
  );
  const gateRequest = provider.requests.find(
    (request) => request.role === "gate",
  );
  assert.deepEqual(agentRequest?.volumes, [{
    volumeName: "harness-claude-observability",
    mountPath: "/harness-observability",
    subpath: "runs/run-obs",
  }]);
  assert.equal(gateRequest?.volumes, undefined);

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  const mkdirCall = agent.executeCalls.find((call) =>
    call.command === 'mkdir -p "$HARNESS_OBSERVABILITY_ATTEMPT_ROOT"'
  );
  assert.equal(
    mkdirCall?.env.HARNESS_OBSERVABILITY_ATTEMPT_ROOT,
    "/harness-observability/attempt-1",
  );
  assert.equal(mkdirCall?.timeoutMs, 30_000);

  const claudeCall = agent.executeCalls.find((call) =>
    call.command === CLAUDE_COMMAND
  );
  assert.equal(
    claudeCall ? "CLAUDE_CONFIG_DIR" in claudeCall.env : true,
    false,
  );
  assert.equal(
    claudeCall?.env.HARNESS_CLAUDE_HOME_SNAPSHOT_DIR,
    "/harness-observability/.claude",
  );
  assert.equal(claudeCall?.env.HARNESS_RUN_ID, "run-obs");
  assert.equal(claudeCall?.env.HARNESS_ATTEMPT, "1");
  assert.equal(
    claudeCall?.env.HARNESS_OBSERVABILITY_RUN_ROOT,
    "/harness-observability",
  );
  assert.equal(
    claudeCall?.env.HARNESS_OBSERVABILITY_ATTEMPT_ROOT,
    "/harness-observability/attempt-1",
  );
  const snapshotCall = agent.executeCalls.find((call) =>
    call.command.includes("HARNESS_CLAUDE_HOME_SNAPSHOT_DIR") &&
    call.command.includes("cp -R")
  );
  assert.equal(
    snapshotCall?.env.HARNESS_CLAUDE_HOME_SNAPSHOT_DIR,
    "/harness-observability/.claude",
  );
  assert.equal(
    agent.executeCalls.indexOf(snapshotCall!),
    agent.executeCalls.indexOf(claudeCall!) + 1,
  );

  const commandStart = observations.find(([event]) =>
    event === "agent.command.start"
  );
  assert.equal(
    (commandStart?.[1] as { claudeStreamPath?: string }).claudeStreamPath,
    "/harness-observability/attempt-1/claude-stream.jsonl",
  );
  assert.equal(
    (commandStart?.[1] as { claudeHomeSnapshotDir?: string }).claudeHomeSnapshotDir,
    "/harness-observability/.claude",
  );
  const observabilityStart = observations.find(([event]) =>
    event === "agent.observability.start"
  );
  assert.equal(
    (observabilityStart?.[1] as { attempt?: number }).attempt,
    1,
  );
  assert.equal(
    (observabilityStart?.[1] as { claudeConfigDir?: string }).claudeConfigDir,
    "/home/daytona/.claude",
  );
  const observabilityEnd = observations.find(([event]) =>
    event === "agent.observability.end"
  );
  assert.equal(
    (observabilityEnd?.[1] as { outcome?: string }).outcome,
    "ready",
  );
  assert.equal(
    (observabilityEnd?.[1] as { attempt?: number }).attempt,
    1,
  );
  assert.equal((commandStart?.[1] as { attempt?: number }).attempt, 1);
  assert.equal(
    (commandStart?.[1] as { claudeConfigDir?: string }).claudeConfigDir,
    "/home/daytona/.claude",
  );
  const snapshotStart = observations.find(([event]) =>
    event === "agent.observability.claude-home.start"
  );
  assert.equal(
    (snapshotStart?.[1] as { path?: string }).path,
    "/harness-observability/.claude",
  );
  const snapshotEnd = observations.find(([event]) =>
    event === "agent.observability.claude-home.end"
  );
  assert.equal(
    (snapshotEnd?.[1] as { outcome?: string }).outcome,
    "copied",
  );
  for (const eventName of [
    "gate.create.start",
    "gate.create.end",
    "gate.run.start",
    "gate.run.end",
    "gate.cleanup.start",
    "gate.cleanup.end",
  ]) {
    const event = observations.find(([name]) => name === eventName);
    assert.equal(
      (event?.[1] as { attempt?: number }).attempt,
      1,
      `${eventName} attempt`,
    );
  }
});

test("Claude Daytona observability persists raw stream-json stdout", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "Read" }],
    },
  });
  const toolResult = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1" }],
    },
  });
  const result = JSON.stringify({
    type: "result",
    session_id: "session-stream",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [`${assistant}\n${toolResult}\n${result}\n`],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-stream",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  assert.equal(
    agent.files.get("/harness-observability/attempt-1/claude-stream.jsonl")
      ?.content.toString(),
    `${assistant}\n${toolResult}\n${result}\n`,
  );
  assert.equal(
    agent.executeCalls.some((call) =>
      "HARNESS_CLAUDE_STREAM_TMP" in call.env
    ),
    false,
  );
  const streamEvent = observations.find(([event]) =>
    event === "agent.observability.stream"
  );
  assert.deepEqual(streamEvent?.[1], {
    id: "agent-1",
    attempt: 1,
    path: "/harness-observability/attempt-1/claude-stream.jsonl",
    bytes: Buffer.byteLength(`${assistant}\n${toolResult}\n${result}\n`),
  });
});

test("Claude Daytona emits live stream progress before command end", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: "Bash",
        input: { command: "npm view @dcloudio/uni-app version" },
      }],
    },
  });
  const result = JSON.stringify({
    type: "result",
    session_id: "session-live",
  });
  let releaseClaude: () => void = () => undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseClaude = resolve;
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [`${assistant}\n${result}\n`],
    claudeRunHooks: [async () => await waitForRelease],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-live-stream",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const task = environment.runTask({ task: "fix it" });
  try {
    await delay(120);
    const progressIndex = observations.findIndex(([event]) =>
      event === "agent.command.progress"
    );
    const endIndex = observations.findIndex(([event]) =>
      event === "agent.command.end"
    );

    assert.notEqual(progressIndex, -1);
    assert.equal(endIndex, -1);
    assert.ok(
      observations.some(([event, data]) =>
        event === "agent.claude.tool" &&
        (data as { tool?: string }).tool === "Bash"
      ),
    );
  } finally {
    releaseClaude();
    await task;
  }
});

test("Claude Daytona emits command heartbeat before command end", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const observations: Array<[string, unknown]> = [];
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-heartbeat" }),
    ],
    claudeRunHooks: [async () => {
      await waitUntil(() =>
        observations.some(([event]) => event === "agent.command.heartbeat")
      );
    }],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    heartbeatIntervalMs: 5,
    observability: {
      runId: "run-command-heartbeat",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });

  const heartbeatIndex = observations.findIndex(([event]) =>
    event === "agent.command.heartbeat"
  );
  const endIndex = observations.findIndex(([event]) =>
    event === "agent.command.end"
  );
  const heartbeat = observations[heartbeatIndex]?.[1] as {
    id?: string;
    attempt?: number;
    kind?: string;
    elapsedMs?: number;
    claudeStreamPath?: string;
  };

  assert.notEqual(heartbeatIndex, -1);
  assert.notEqual(endIndex, -1);
  assert.ok(heartbeatIndex < endIndex);
  assert.equal(heartbeat.id, "agent-1");
  assert.equal(heartbeat.attempt, 1);
  assert.equal(heartbeat.kind, "claude");
  assert.equal(typeof heartbeat.elapsedMs, "number");
  assert.equal(
    heartbeat.claudeStreamPath,
    "/harness-observability/attempt-1/claude-stream.jsonl",
  );
});

test("Claude Daytona command heartbeat stops during slow final stream read", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const observations: Array<[string, unknown]> = [];
  let streamReads = 0;
  let delayedReadStarted = false;
  let releaseDelayedRead: () => void = () => undefined;
  const delayedRead = new Promise<void>((resolve) => {
    releaseDelayedRead = resolve;
  });
  const heartbeatCount = () =>
    observations.filter(([event]) => event === "agent.command.heartbeat")
      .length;

  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [
      `${JSON.stringify({ type: "result", session_id: "session-heartbeat" })}\n`,
    ],
    claudeRunHooks: [async () => {
      await waitUntil(() => heartbeatCount() > 0);
    }],
    readFileHook: async (_handle, path) => {
      if (!path.endsWith("/claude-stream.jsonl")) return;
      streamReads++;
      if (streamReads !== 2) return;
      delayedReadStarted = true;
      await delayedRead;
    },
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    heartbeatIntervalMs: 5,
    observability: {
      runId: "run-command-heartbeat-final-read",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const task = environment.runTask({ task: "fix it" });
  let countDuringFinalRead = 0;
  let countAfterSlowRead = 0;
  try {
    await waitUntil(() => delayedReadStarted, 500);
    countDuringFinalRead = heartbeatCount();
    await delay(25);
    countAfterSlowRead = heartbeatCount();
  } finally {
    releaseDelayedRead();
    await task;
  }

  assert.equal(countAfterSlowRead, countDuringFinalRead);
});

test("Claude Daytona rejects invalid heartbeat interval overrides before sandbox creation", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });

  for (const heartbeatIntervalMs of [0, -1, Number.POSITIVE_INFINITY, NaN, 1.5]) {
    const provider = scriptedProvider({
      candidateVersions: ["fixed\n"],
      gateExitCodes: [0],
    });

    assert.throws(
      () =>
        createDaytonaRunEnvironment({
          provider,
          root,
          policy: policy(),
          agent: { kind: "claude" },
          environment: configuredClaudeEnvironment,
          heartbeatIntervalMs,
        }),
      /heartbeatIntervalMs/,
    );
    assert.deepEqual(provider.requests, []);
  }
});

test("Claude Daytona retries strongly resume the captured session in one agent sandbox", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-abc" }),
      JSON.stringify({ type: "result", session_id: "session-abc" }),
    ],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-resume",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(
    provider.requests.filter((request) => request.role === "agent").length,
    1,
  );
  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    2,
  );
  assert.equal(provider.claudeRuns, 2);

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  const claudeCalls = agent.executeCalls.filter((call) =>
    call.command.includes("/usr/local/bin/claude") &&
    "HARNESS_PROMPT" in call.env
  );
  assert.equal(claudeCalls.length, 2);
  assert.equal(claudeCalls[0]?.command, buildClaudeCommand());
  assert.equal("HARNESS_CLAUDE_SESSION_ID" in claudeCalls[0]!.env, false);
  assert.equal(claudeCalls[1]?.command, buildClaudeCommand("resume"));
  assert.equal(claudeCalls[1]?.command.includes("session-abc"), false);
  assert.equal(
    claudeCalls[1]?.env.HARNESS_CLAUDE_SESSION_ID,
    "session-abc",
  );
  assert.deepEqual(
    claudeCalls.map((call) => "CLAUDE_CONFIG_DIR" in call.env),
    [false, false],
  );

  const commandStarts = observations.filter(([event]) =>
    event === "agent.command.start"
  );
  assert.equal(commandStarts.length, 2);
  assert.deepEqual(commandStarts.map(([, data]) => ({
    attempt: (data as { attempt?: number }).attempt,
    resume: (data as { resume?: boolean }).resume,
    claudeSessionId: (data as { claudeSessionId?: string }).claudeSessionId,
  })), [
    { attempt: 1, resume: false, claudeSessionId: undefined },
    { attempt: 2, resume: true, claudeSessionId: "session-abc" },
  ]);
});

test("retained Daytona resume attaches to the existing agent and publishes if Gate now passes", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [0],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("fixed\n"), false),
  );
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: retainingPolicy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeSessionId: "session-abc",
      completedAttempts: 3,
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(
    provider.requests.filter((request) => request.role === "agent").length,
    0,
  );
  assert.deepEqual(provider.attachedIds, ["retained-agent"]);
  assert.equal(provider.claudeRuns, 0);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "fixed\n");
  assert.equal(retained.deleted, 1);
  assert.equal(
    observations.some(([event]) => event === "agent.attach.end"),
    true,
  );
});

test("retained Daytona resume rejects unsafe captured Claude session ids", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });

  for (const claudeSessionId of ["", " session-abc", "session-abc ", "session\nabc"]) {
    const provider = scriptedProvider({
      candidateVersions: [],
      gateExitCodes: [],
    });

    assert.throws(
      () =>
        createDaytonaRunEnvironment({
          provider,
          root,
          policy: retainingPolicy(),
          agent: { kind: "claude" },
          environment: configuredClaudeEnvironment,
          resume: {
            agentSandboxId: "retained-agent",
            claudeSessionId,
            completedAttempts: 1,
          },
        }),
      /Claude session id/i,
    );
  }
});

test("retained Daytona resume preserves attached sandbox when preflight fails", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [],
    throwCommands: {
      [CLAUDE_TOOLCHAIN_PREFLIGHT]: new Error("preflight boom"),
    },
  });
  const retained = provider.createAttachedAgent("retained-agent");
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeSessionId: "session-abc",
      completedAttempts: 1,
    },
  });

  await assert.rejects(
    () =>
      runLoop({
        task: "fix it",
        contracts: [{ id: "trusted", type: "command", cmd: "true" }],
        gate: new GateCore().use(commandPlugin),
        ctx: { cwd: root },
        environment,
        budget,
        startWithGate: true,
      }),
    /preflight boom/,
  );
  assert.deepEqual(provider.attachedIds, ["retained-agent"]);
  assert.equal(retained.deleted, 0);
});

test("retained Daytona resume continues Claude with the captured session when Gate still fails", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-abc",
      }),
    ],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: retainingPolicy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeSessionId: "session-abc",
      completedAttempts: 3,
    },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  const claudeCalls = retained.executeCalls.filter((call) =>
    call.command.includes("/usr/local/bin/claude") &&
    "HARNESS_PROMPT" in call.env
  );
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0]?.command, buildClaudeCommand("resume"));
  assert.equal(claudeCalls[0]?.env.HARNESS_CLAUDE_SESSION_ID, "session-abc");
  assert.match(claudeCalls[0]?.env.HARNESS_PROMPT ?? "", /门禁反馈/);
});

test("retained Daytona resume rejects error stream result before later safe success", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-1/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        [
          '{"type":"result","subtype":"success","is_error":true,"session_id":"session-abc"}',
          '{"type":"result","subtype":"success","session_id":"session-safe"}',
          "",
        ].join("\n"),
      ),
      false,
    ),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 1,
      recoverCompletedCommand: true,
    },
  });

  await assert.rejects(
    () =>
      runLoop({
        task: "fix it",
        contracts: [{ id: "trusted", type: "command", cmd: "true" }],
        gate: new GateCore().use(commandPlugin),
        ctx: { cwd: root },
        environment,
        budget,
        startWithGate: true,
      }),
    /successful result session id/,
  );
  assert.equal(provider.claudeRuns, 0);
  assert.equal(retained.deleted, 0);
});

test("retained Daytona resume rejects unsafe Claude stream session ids during recovery", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-1/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        '{"type":"result","subtype":"success","session_id":" session-abc"}\n',
      ),
      false,
    ),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 1,
      recoverCompletedCommand: true,
    },
  });

  await assert.rejects(
    () =>
      runLoop({
        task: "fix it",
        contracts: [{ id: "trusted", type: "command", cmd: "true" }],
        gate: new GateCore().use(commandPlugin),
        ctx: { cwd: root },
        environment,
        budget,
        startWithGate: true,
      }),
    /successful result session id/,
  );
  assert.equal(retained.deleted, 0);
});

test("retained Daytona resume rejects unsafe stream result before later safe result", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-1/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        [
          '{"type":"result","subtype":"success","session_id":" session-abc"}',
          '{"type":"result","subtype":"success","session_id":"session-safe"}',
          "",
        ].join("\n"),
      ),
      false,
    ),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 1,
      recoverCompletedCommand: true,
    },
  });

  await assert.rejects(
    () =>
      runLoop({
        task: "fix it",
        contracts: [{ id: "trusted", type: "command", cmd: "true" }],
        gate: new GateCore().use(commandPlugin),
        ctx: { cwd: root },
        environment,
        budget,
        startWithGate: true,
      }),
    /successful result session id/,
  );
  assert.equal(provider.claudeRuns, 0);
  assert.equal(retained.deleted, 0);
});

test("retained Daytona resume recovers a completed Claude session from stream before Gate", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: [],
    gateExitCodes: [0],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-1/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("fixed\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        '{"type":"result","subtype":"success","terminal_reason":"completed","session_id":"session-abc"}\n',
      ),
      false,
    ),
  );
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: retainingPolicy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 1,
      recoverCompletedCommand: true,
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.equal(provider.claudeRuns, 0);
  assert.deepEqual(
    observations
      .filter(([event]) => event === "agent.command.recovered")
      .map(([, data]) => data),
    [{
      id: "retained-agent",
      attempt: 1,
      claudeSessionId: "session-abc",
      claudeStreamPath: streamPath,
      exitCode: 0,
      outcome: "success",
    }],
  );
});

test("retained Daytona resume reports absolute attempts for recovered command and gates", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-abc",
      }),
    ],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-3/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        '{"type":"result","subtype":"success","terminal_reason":"completed","session_id":"session-abc"}\n',
      ),
      false,
    ),
  );
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: retainingPolicy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 3,
      recoverCompletedCommand: true,
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.deepEqual(
    observations
      .filter(([, data]) => typeof (data as { attempt?: unknown }).attempt === "number")
      .filter(([event]) =>
        event === "agent.command.recovered" ||
        event === "agent.command.start" ||
        event === "candidate.collect.start" ||
        event === "candidate.collect.end" ||
        event === "gate.run.start" ||
        event === "gate.run.end"
      )
      .map(([event, data]) => [
        event,
        (data as { attempt: number }).attempt,
      ]),
    [
      ["agent.command.recovered", 3],
      ["candidate.collect.start", 3],
      ["candidate.collect.end", 3],
      ["gate.run.start", 3],
      ["gate.run.end", 3],
      ["agent.command.start", 4],
      ["candidate.collect.start", 4],
      ["candidate.collect.end", 4],
      ["gate.run.start", 4],
      ["gate.run.end", 4],
    ],
  );
});

test("retained Daytona resume uses recovered stream session when Gate still fails", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [1, 0],
    claudeStdouts: [
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-abc",
      }),
    ],
  });
  const retained = provider.createAttachedAgent("retained-agent");
  const streamPath = "/harness-observability/attempt-1/claude-stream.jsonl";
  retained.files.set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("still-broken\n"), false),
  );
  retained.files.set(
    streamPath,
    workspaceFile(
      streamPath,
      Buffer.from(
        '{"type":"result","subtype":"success","terminal_reason":"completed","session_id":"session-abc"}\n',
      ),
      false,
    ),
  );
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: retainingPolicy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    resume: {
      agentSandboxId: "retained-agent",
      claudeStreamPath: streamPath,
      completedAttempts: 1,
      recoverCompletedCommand: true,
    },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    startWithGate: true,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  const claudeCalls = retained.executeCalls.filter((call) =>
    call.command.includes("/usr/local/bin/claude") &&
    "HARNESS_PROMPT" in call.env
  );
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0]?.command, buildClaudeCommand("resume"));
  assert.equal(claudeCalls[0]?.env.HARNESS_CLAUDE_SESSION_ID, "session-abc");
});

test("Claude Daytona fails closed when the first attempt does not report a session id", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: [JSON.stringify({ type: "result" })],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    onObservation: (event, data) => observations.push([event, data]),
  });

  await assert.rejects(
    () => environment.runTask({ task: "fix it" }),
    /Claude session id/i,
  );
  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    0,
  );
  const commandEnd = observations.find(([event]) =>
    event === "agent.command.end"
  );
  assert.equal(
    (commandEnd?.[1] as { outcome?: string }).outcome,
    "error",
  );
});

test("Claude Daytona reports command output when the first attempt does not report a session id", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    claudeStdouts: ["zsh: read-only variable: status\n"],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
  });

  await assert.rejects(
    () => environment.runTask({ task: "fix it" }),
    /Claude session id.*zsh: read-only variable: status/is,
  );
});

test("Claude Daytona rejects changed session id during resume", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [1],
    claudeStdouts: [
      JSON.stringify({ type: "result", session_id: "session-a" }),
      JSON.stringify({ type: "result", session_id: "session-b" }),
    ],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });
  assert.equal(report.outcome, "fail");

  await assert.rejects(
    () =>
      environment.runTask({
        task: "fix it",
        feedback: "trusted test failed",
      }),
    /changed|session/i,
  );

  const commandEnds = observations.filter(([event]) =>
    event === "agent.command.end"
  );
  const attempt2End = commandEnds.find(([, data]) =>
    (data as { attempt?: number }).attempt === 2
  );
  assert.equal(
    (attempt2End?.[1] as { outcome?: string }).outcome,
    "error",
  );
  assert.match(
    (attempt2End?.[1] as { errorReason?: string }).errorReason ?? "",
    /changed|session/i,
  );
  assert.equal(
    provider.requests.filter((request) => request.role === "gate").length,
    1,
  );
  assert.equal(
    observations.some(([event, data]) =>
      event === "gate.run.end" &&
      (data as { outcome?: string }).outcome === "pass"
    ),
    false,
  );
  const publication = await environment.publish();
  assert.equal(publication.ok, false);
});

test("Claude Daytona observability rejects unsafe run ids before sandbox creation", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });

  for (const runId of ["", "../escape", "nested/run", "run\\id", "run\0id"]) {
    const provider = scriptedProvider({
      candidateVersions: ["fixed\n"],
      gateExitCodes: [0],
    });

    assert.throws(
      () =>
        createDaytonaRunEnvironment({
          provider,
          root,
          policy: policy(),
          agent: { kind: "claude" },
          environment: configuredClaudeEnvironment,
          observability: {
            runId,
            config: loadDaytonaObservabilityConfig({}),
          },
        }),
      /runId/,
    );
    assert.equal(provider.requests.length, 0);
  }
});

test("Claude Daytona observability emits an error end event when setup throws", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    throwCommands: {
      'mkdir -p "$HARNESS_OBSERVABILITY_ATTEMPT_ROOT"': new Error("toolbox unavailable"),
    },
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-obs",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await assert.rejects(
    () => environment.runTask({ task: "fix it" }),
    /toolbox unavailable/,
  );

  const observabilityEnd = observations.find(([event]) =>
    event === "agent.observability.end"
  );
  assert.equal(
    (observabilityEnd?.[1] as { outcome?: string }).outcome,
    "error",
  );
  assert.equal(
    (observabilityEnd?.[1] as { attempt?: number }).attempt,
    1,
  );
  assert.equal(
    observations.some(([event]) => event === "agent.command.start"),
    false,
  );
});

test("Claude Daytona command rejection emits a command error end event", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    throwCommands: {
      [CLAUDE_COMMAND]: new Error("toolbox timeout"),
    },
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
    observability: {
      runId: "run-obs",
      config: loadDaytonaObservabilityConfig({}),
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await assert.rejects(
    () => environment.runTask({ task: "fix it" }),
    /toolbox timeout/,
  );

  const commandEnd = observations.find(([event]) =>
    event === "agent.command.end"
  );
  assert.equal(
    (commandEnd?.[1] as { outcome?: string }).outcome,
    "error",
  );
  assert.equal(
    (commandEnd?.[1] as { errorReason?: string }).errorReason,
    "toolbox timeout",
  );
  assert.equal(
    (commandEnd?.[1] as { attempt?: number }).attempt,
    1,
  );
});

test("Claude Daytona observations report safe stages without prompt or credential text", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [1, 0],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "claude" },
    environment: {
      ...configuredClaudeEnvironment,
      DAYTONA_API_KEY: "daytona-secret-key",
    },
    onObservation: (event, data) => observations.push([event, data]),
  });

  const outcome = await runLoop({
    task: "fix highly sensitive task text",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
    initialFeedback: "private reviewer feedback",
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  const events = observations.map(([event]) => event);
  for (const event of [
    "agent.create.start",
    "agent.upload.end",
    "agent.preflight.end",
    "agent.setup.end",
    "agent.command.end",
    "candidate.collect.end",
    "gate.create.end",
    "gate.upload.end",
    "gate.setup.end",
    "gate.network.end",
    "gate.run.end",
    "gate.cleanup.end",
    "agent.cleanup.end",
  ]) {
    assert.ok(events.includes(event), `missing observation: ${event}`);
  }
  const ended = observations.filter(([event]) => event.endsWith(".end"));
  assert.ok(ended.length > 0);
  for (const [, data] of ended) {
    assert.equal(typeof (data as { durationMs?: unknown }).durationMs, "number");
  }
  const serialized = JSON.stringify(observations);
  for (const secret of [
    configuredClaudeEnvironment.ANTHROPIC_AUTH_TOKEN,
    "daytona-secret-key",
    "fix highly sensitive task text",
    "private reviewer feedback",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("Claude agent environment rejects blank runtime snapshot overrides before sandbox creation", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  for (const [key, value] of [
    ["HARNESS_DAYTONA_AGENT_SNAPSHOT", "   "],
    ["HARNESS_DAYTONA_GATE_SNAPSHOT", "   "],
  ] as const) {
    const provider = scriptedProvider({
      candidateVersions: ["fixed\n"],
      gateExitCodes: [0],
    });

    assert.throws(
      () =>
        createDaytonaRunEnvironment({
          provider,
          root,
          policy: policy(),
          agent: { kind: "claude" },
          environment: { ...modelEnvironment, [key]: value },
        }),
      new RegExp(key),
    );
    assert.deepEqual(provider.requests, []);
  }
});

test("Claude agent setup executes after preflight without using a PTY", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy({ agentSetup: ["npm install", "npm test"] }),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
  });

  await environment.runTask({ task: "fix it" });

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  assert.deepEqual(agent.commands.slice(0, 3), [
    CLAUDE_TOOLCHAIN_PREFLIGHT,
    "npm install",
    "npm test",
  ]);
  assert.deepEqual(
    agent.executeCalls.slice(0, 3).map((call) => call.timeoutMs),
    [30_000, 10 * 60 * 1000, 10 * 60 * 1000],
  );
  assert.equal(agent.ptyCommands.includes("npm install"), false);
  assert.equal(agent.ptyCommands.includes("npm test"), false);
  assert.equal(agent.ptyCommands.includes(CLAUDE_COMMAND), false);
  assert.equal(agent.commands.includes(CLAUDE_COMMAND), true);
  assert.equal(
    agent.executeCalls.find((call) => call.command === CLAUDE_COMMAND)
      ?.timeoutMs,
    undefined,
  );
});

test("agent setup failure stops later setup and deletes the sandbox", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    commandExitCodes: { "npm install": 127 },
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy({ agentSetup: ["npm install", "npm test"] }),
    agent: { kind: "claude" },
    environment: configuredClaudeEnvironment,
  });

  await assert.rejects(
    environment.runTask({ task: "fix it" }),
    /agent setup command 1 failed with exit 127/i,
  );

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  assert.deepEqual(agent.commands, [
    CLAUDE_TOOLCHAIN_PREFLIGHT,
    "npm install",
  ]);
  assert.equal(agent.commands.includes("npm test"), false);
  assert.deepEqual(agent.ptyCommands, []);
  assert.equal(agent.deleted, 1);
});

test("command agent setup uses execute without Claude preflight", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy({ agentSetup: ["npm install"] }),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });

  const agent = provider.handles.find((handle) => handle.role === "agent")!;
  assert.equal(agent.commands[0], "npm install");
  assert.equal(agent.commands.includes(CLAUDE_TOOLCHAIN_PREFLIGHT), false);
  assert.equal(agent.ptyCommands.includes("npm install"), false);
  assert.deepEqual(agent.ptyCommands, ["fake-agent"]);
  assert.equal(agent.executeCalls[0]?.timeoutMs, 10 * 60 * 1000);
});

test("gate setup uses execute and stops after the first failure", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    commandExitCodes: { "npm install": 127 },
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy({ gateSetup: ["npm install", "npm test"] }),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });

  const gate = provider.handles.find((handle) => handle.role === "gate")!;
  assert.equal(report.outcome, "fail");
  assert.equal(report.results[0]?.status, "error");
  assert.match(
    report.results[0]?.errorReason ?? "",
    /gate setup command 1 failed with exit 127/i,
  );
  assert.deepEqual(gate.commands, ["npm install"]);
  assert.deepEqual(gate.ptyCommands, []);
  assert.equal(gate.executeCalls[0]?.timeoutMs, 10 * 60 * 1000);
  assert.equal(gate.deleted, 1);
});

test("gate setup runs after candidate files are assembled", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy({ gateSetup: ["assert-candidate-visible"] }),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });

  const gate = provider.handles.find((handle) => handle.role === "gate")!;
  assert.equal(report.outcome, "pass");
  assert.deepEqual(gate.commands, [
    "assert-candidate-visible",
    "'/usr/bin/env' '--' 'true'",
  ]);
  assert.equal(gate.deleted, 1);
});

test("gate network remains open for loopback HTTP contracts", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const observations: Array<[string, unknown]> = [];
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
    onObservation: (event, data) => observations.push([event, data]),
  });

  await environment.runTask({ task: "fix it" });
  await environment.runGate({
    contracts: [{
      id: "health",
      type: "http",
      trigger: {
        baseUrl: "http://127.0.0.1:3000",
        path: "/health",
      },
    }],
    gate: new GateCore(),
    ctx: { cwd: root },
  });

  const gate = provider.handles.find((handle) => handle.role === "gate")!;
  assert.deepEqual(gate.networkBlocks, []);
  const networkEnd = observations.find(([event]) => event === "gate.network.end");
  assert.equal((networkEnd?.[1] as { id?: string }).id, gate.id);
  assert.equal((networkEnd?.[1] as { blocked?: boolean }).blocked, false);
  assert.equal((networkEnd?.[1] as { reason?: string }).reason, "loopback-http");
  assert.equal(typeof (networkEnd?.[1] as { durationMs?: unknown }).durationMs, "number");
});

test("publication uses the evaluated candidate instead of recollecting agent files", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["evaluated\n"],
    gateExitCodes: [0],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });
  await environment.runTask({ task: "fix it", feedback: "" });
  const report = await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });
  assert.equal(report.outcome, "pass");

  provider.agentFiles().set(
    "src/a.ts",
    workspaceFile("src/a.ts", Buffer.from("mutated-later\n"), false),
  );
  const publication = await environment.publish();
  await environment.close();

  assert.equal(publication.ok, true);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "evaluated\n");
});

test("agent-reported pass text cannot override failing gate evidence", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n"],
    gateExitCodes: [1],
    agentStdout: "all tests passed",
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget: { ...budget, maxAttempts: 1 },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.report.outcome, "fail");
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
});

test("candidate policy violation becomes gate error and is fed back", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [0],
    candidateMutations: [
      (files) => {
        files.set(
          "contracts/forged.yaml",
          workspaceFile(
            "contracts/forged.yaml",
            Buffer.from("forged\n"),
            false,
          ),
        );
      },
      (files) => files.delete("contracts/forged.yaml"),
    ],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.match(provider.agentPrompts[1]!, /候选|路径|允许|contracts/i);
});

test("gate cleanup failure prevents publication", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    gateDeleteFails: true,
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget: { ...budget, maxAttempts: 1 },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.match(
    outcome.report.results[0]?.errorReason ?? "",
    /cleanup|清理|delete/i,
  );
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
});

test("protected gate asset mutation turns a passing command into integrity error", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
    mutateProtectedOnGate: true,
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix it",
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
    environment,
    budget: { ...budget, maxAttempts: 1 },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.report.results[0]?.status, "error");
  assert.match(
    outcome.report.results[0]?.errorReason ?? "",
    /Host-controlled file changed/,
  );
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
});

test("environment refuses publication when the latest gate did not pass", async () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n"],
    gateExitCodes: [1],
  });
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });
  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [{ id: "trusted", type: "command", cmd: "true" }],
    gate: new GateCore().use(commandPlugin),
    ctx: { cwd: root },
  });

  assert.equal(report.outcome, "fail");
  assert.equal((await environment.publish()).ok, false);
  await environment.close();
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "before\n");
});

test("Daytona gate runs miniprogram contracts on host materialized candidate", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [0],
  });
  const hostPlugin: Plugin = {
    type: "miniprogram",
    async run(contract, ctx) {
      return {
        id: contract.id,
        type: this.type,
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "fixed\n"
          ? "pass"
          : "fail",
        durationMs: 1,
        violations: [],
      };
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [
      { id: "remote.command", type: "command", cmd: "true" },
      { id: "mp.host", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(commandPlugin).use(hostPlugin),
    ctx: { cwd: root },
  });

  assert.equal(report.outcome, "pass");
  assert.equal(report.summary.total, 2);
  const gate = provider.handles.find((handle) => handle.role === "gate")!;
  assert.ok(gate.commands.some((command) => command.includes("'true'")));
});

test("Daytona run skips remote gate sandbox when only host-local contracts are selected", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["fixed\n"],
    gateExitCodes: [],
  });
  const hostPlugin: Plugin = {
    type: "miniprogram",
    async run(contract, ctx) {
      return {
        id: contract.id,
        type: this.type,
        status: readFileSync(join(ctx.cwd, "src/a.ts"), "utf8") === "fixed\n"
          ? "pass"
          : "fail",
        durationMs: 1,
        violations: [],
      };
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  await environment.runTask({ task: "fix it" });
  const report = await environment.runGate({
    contracts: [
      { id: "mp.only", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
  });

  assert.equal(report.outcome, "pass");
  assert.equal(provider.requests.filter((request) => request.role === "gate").length, 0);
});

test("miniprogram gate failure feeds diagnostics back to the Daytona agent", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "fixed\n"],
    gateExitCodes: [],
  });
  const hostPlugin: Plugin = {
    type: "miniprogram",
    async run(contract, ctx) {
      const content = readFileSync(join(ctx.cwd, "src/a.ts"), "utf8");
      return content === "fixed\n"
        ? {
          id: contract.id,
          type: this.type,
          status: "pass",
          durationMs: 1,
          violations: [],
        }
        : {
          id: contract.id,
          type: this.type,
          status: "fail",
          durationMs: 1,
          violations: [{
            what: "mini-program home page did not render",
            why: "小程序首页必须可见",
            how: "fix src/a.ts",
          }],
        };
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix mp",
    contracts: [
      { id: "mp.loop", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
    environment,
    budget,
  });

  assert.equal(outcome.outcome, "ready_for_mr");
  assert.match(
    provider.agentPrompts[1] ?? "",
    /mp.loop|mini-program home page|fix src\/a.ts/,
  );
});

test("repeated miniprogram gate failure escalates to human_review_contract", async () => {
  const root = createGitFixture({
    "src/a.ts": "before\n",
    "contracts/gate.yaml": "trusted\n",
  });
  const provider = scriptedProvider({
    candidateVersions: ["broken\n", "broken\n", "broken\n"],
    gateExitCodes: [],
  });
  const hostPlugin: Plugin = {
    type: "miniprogram",
    async run(contract) {
      return {
        id: contract.id,
        type: this.type,
        status: "fail",
        durationMs: 1,
        violations: [{
          what: "mini-program contract remains red",
          why: "同一小程序契约重复失败",
          how: "review contract or fix implementation",
        }],
      };
    },
  };
  const environment = createDaytonaRunEnvironment({
    provider,
    root,
    policy: policy(),
    agent: { kind: "command", command: "fake-agent" },
  });

  const outcome = await runLoop({
    task: "fix mp",
    contracts: [
      { id: "mp.repeat", type: "miniprogram", projectPath: "src", runner: "contracts/gate.yaml" },
    ],
    gate: new GateCore().use(hostPlugin),
    ctx: { cwd: root },
    environment,
    budget: { ...budget, repeatWallThreshold: 2, maxAttempts: 5 },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.action?.kind, "human_review_contract");
});

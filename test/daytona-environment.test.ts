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

interface ScriptedProvider extends SandboxProvider {
  requests: SandboxCreateRequest[];
  handles: RecordingHandle[];
  agentPrompts: string[];
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
      agentPrompts: string[];
      agentRuns: number;
      gateRuns: number;
      agentStdout: string;
      candidateMutations: Array<
        ((files: Map<string, WorkspaceFile>) => void) | undefined
      >;
      gateDeleteFails: boolean;
      mutateProtectedOnGate: boolean;
      commandExitCodes: Record<string, number>;
      throwCommands: Record<string, Error>;
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
        [...this.files.values()].map((file) => ({
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
  agentStdout?: string;
  candidateMutations?: Array<
    ((files: Map<string, WorkspaceFile>) => void) | undefined
  >;
  gateDeleteFails?: boolean;
  mutateProtectedOnGate?: boolean;
  commandExitCodes?: Record<string, number>;
  throwCommands?: Record<string, Error>;
}): ScriptedProvider {
  const state = {
    ...options,
    agentStdout: options.agentStdout ?? "agent done",
    candidateMutations: options.candidateMutations ?? [],
    gateDeleteFails: options.gateDeleteFails ?? false,
    mutateProtectedOnGate: options.mutateProtectedOnGate ?? false,
    commandExitCodes: options.commandExitCodes ?? {},
    throwCommands: options.throwCommands ?? {},
    agentPrompts: [] as string[],
    agentRuns: 0,
    gateRuns: 0,
  };
  const requests: SandboxCreateRequest[] = [];
  const handles: RecordingHandle[] = [];
  return {
    requests,
    handles,
    agentPrompts: state.agentPrompts,
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
    agentFiles() {
      const agent = handles.find((handle) => handle.role === "agent");
      if (!agent) throw new Error("agent not created");
      return agent.files;
    },
  };
}

test("multiple attempts reuse one agent and create a fresh gate each time", async () => {
  const root = createGitFixture({
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
  assert.equal(gates[0]?.files.has(".git/HEAD"), false);
  assert.equal(
    gates[0]?.files.get("contracts/gate.yaml")?.content.toString(),
    "trusted\n",
  );
  assert.ok(gates.every((handle) => handle.verifications === 2));
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

test("Claude Daytona observability mounts only the Agent sandbox and sets CLAUDE_CONFIG_DIR", async () => {
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
    call.command === 'mkdir -p "$CLAUDE_CONFIG_DIR"'
  );
  assert.equal(
    mkdirCall?.env.CLAUDE_CONFIG_DIR,
    "/harness-observability/attempt-1/.claude",
  );
  assert.equal(mkdirCall?.timeoutMs, 30_000);

  const claudeCall = agent.executeCalls.find((call) =>
    call.command === CLAUDE_COMMAND
  );
  assert.equal(
    claudeCall?.env.CLAUDE_CONFIG_DIR,
    "/harness-observability/attempt-1/.claude",
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

  const commandStart = observations.find(([event]) =>
    event === "agent.command.start"
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
    "/harness-observability/attempt-1/.claude",
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
    "/harness-observability/attempt-1/.claude",
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
      'mkdir -p "$CLAUDE_CONFIG_DIR"': new Error("toolbox unavailable"),
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
    20 * 60 * 1000,
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

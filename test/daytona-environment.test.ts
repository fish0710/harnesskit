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
  createDaytonaRunEnvironment,
} from "../src/harness/sandbox/environment.js";
import { loadSandboxPolicy } from "../src/harness/sandbox/policy.js";
import { workspaceFile } from "../src/harness/sandbox/workspace.js";
import type {
  SandboxCreateRequest,
  SandboxHandle,
  SandboxProvider,
  WorkspaceFile,
} from "../src/harness/sandbox/types.js";
import { runLoop, type GenerationBudget } from "../src/harness/run.js";

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

function policy() {
  return loadSandboxPolicy({
    sandbox: {
      candidateRoots: ["src"],
      protectedPaths: ["contracts"],
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
    _cwd: string,
    env: Record<string, string> = {},
  ) {
    this.commands.push(command);
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
}): ScriptedProvider {
  const state = {
    ...options,
    agentStdout: options.agentStdout ?? "agent done",
    candidateMutations: options.candidateMutations ?? [],
    gateDeleteFails: options.gateDeleteFails ?? false,
    mutateProtectedOnGate: options.mutateProtectedOnGate ?? false,
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

test("gate sandboxes receive no model credentials or Claude installation", async () => {
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
  assert.equal(gateRequest?.snapshot, undefined);
  assert.deepEqual(gateRequest?.envVars, {});
  assert.equal(
    gateHandle?.commands.some((command) => command.includes("claude")),
    false,
  );
  const agentHandle = provider.handles.find(
    (handle) => handle.role === "agent",
  );
  assert.equal(
    agentHandle?.ptyCommands.some((command) =>
      command.includes("npm install")
    ),
    false,
  );
});

test("Claude agent environment requires a configured Agent Snapshot before sandbox creation", () => {
  const root = createGitFixture({ "src/a.ts": "before\n" });
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
        environment: modelEnvironment,
      }),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
  assert.deepEqual(provider.requests, []);
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

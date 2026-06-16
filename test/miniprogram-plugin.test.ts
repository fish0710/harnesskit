import { test } from "node:test";
import assert from "node:assert/strict";

import { GateCore } from "../src/gate.js";
import type {
  CommandExecutionRequest,
  ExecutionTarget,
  HttpExecutionRequest,
} from "../src/harness/execution.js";
import { miniprogramPlugin } from "../src/plugins/miniprogram.js";

function unusedRequest(_request: HttpExecutionRequest): Promise<never> {
  return Promise.reject(new Error("HTTP execution was not expected"));
}

function fakeExecution(
  response: (request: CommandExecutionRequest) => {
    executionId?: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    error?: string;
  },
): { execution: ExecutionTarget; calls: CommandExecutionRequest[] } {
  const calls: CommandExecutionRequest[] = [];
  return {
    calls,
    execution: {
      async execute(request) {
        calls.push(request);
        const result = response(request);
        return {
          executionId: result.executionId ?? request.executionId,
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          durationMs: result.durationMs ?? 5,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      },
      request: unusedRequest,
    },
  };
}

test("miniprogram plugin registers under a stable type", () => {
  const gate = new GateCore().use(miniprogramPlugin);
  assert.deepEqual(gate.plugins(), ["miniprogram"]);
});

test("miniprogram plugin errors on invalid project or runner paths", async () => {
  const result = await miniprogramPlugin.run(
    {
      id: "mp.invalid",
      type: "miniprogram",
      projectPath: "../dist",
      runner: "/tmp/runner.js",
    },
    { cwd: process.cwd() },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /路径|path|越界|absolute|绝对/);
});

test("miniprogram plugin rejects backslash traversal paths", async (t) => {
  const cases = [
    {
      name: "project path parent traversal",
      projectPath: "..\\outside",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "runner nested parent traversal",
      projectPath: "test/fixtures/mp-project",
      runner: "foo\\..\\..\\outside",
    },
    {
      name: "project path internal slash traversal",
      projectPath: "foo/../test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "project path internal backslash traversal",
      projectPath: "foo\\..\\test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "project path Windows drive absolute",
      projectPath: "C:\\outside",
      runner: "test/fixtures/miniprogram-runner.js",
    },
    {
      name: "runner Windows drive absolute",
      projectPath: "test/fixtures/mp-project",
      runner: "C:/outside",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const result = await miniprogramPlugin.run(
        {
          id: `mp.invalid.${testCase.name}`,
          type: "miniprogram",
          projectPath: testCase.projectPath,
          runner: testCase.runner,
        },
        { cwd: process.cwd() },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", /路径|path|越界|absolute|绝对/);
    });
  }
});

test("miniprogram plugin classifies runner exit 0 as pass", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.pass",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args.slice(-1), ["test/fixtures/miniprogram-runner.js"]);
  assert.deepEqual(Object.keys(calls[0]!.env ?? {}).sort(), [
    "HARNESS_MINIPROGRAM_PROJECT",
    "HARNESS_MINIPROGRAM_PROJECT_ABS",
    "HARNESS_MINIPROGRAM_WS_ENDPOINT",
  ]);
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, "test/fixtures/mp-project");
  assert.equal(
    calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT_ABS,
    `${process.cwd()}/test/fixtures/mp-project`,
  );
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:9420");
});

test("miniprogram plugin rejects a directory runner before execution", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.runner.directory",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /runner|文件|file/i);
  assert.equal(calls.length, 0);
});

test("miniprogram plugin classifies runner non-zero as fail", async () => {
  const { execution } = fakeExecution(() => ({
    exitCode: 7,
    stdout: "home title mismatch\nline 2\nline 3\nline 4\nline 5",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.fail",
      type: "miniprogram",
      scenario: "首页契约必须通过",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.what ?? "", /退出码 7/);
  assert.match(result.violations[0]?.why ?? "", /首页契约/);
  assert.match(result.violations[0]?.how ?? "", /home title mismatch/);
  assert.doesNotMatch(result.violations[0]?.how ?? "", /line 5/);
});

test("miniprogram plugin rejects mismatched or incomplete evidence as error", async () => {
  const { execution } = fakeExecution(() => ({
    executionId: "forged",
    exitCode: 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.evidence",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /ID|不匹配|不可信/);
});

test("miniprogram plugin rejects incomplete or errored runner evidence as error", async (t) => {
  const cases = [
    {
      name: "null exit code",
      response: () => ({ exitCode: null }),
      match: /退出码|证据|不可信/,
    },
    {
      name: "invalid duration",
      response: () => ({ exitCode: 0, durationMs: -1 }),
      match: /耗时|证据|不可信/,
    },
    {
      name: "execution target error",
      response: () => ({ exitCode: null, error: "remote spawn failed" }),
      match: /remote spawn failed/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { execution } = fakeExecution(testCase.response);
      const result = await miniprogramPlugin.run(
        {
          id: `mp.evidence.${testCase.name}`,
          type: "miniprogram",
          projectPath: "test/fixtures/mp-project",
          runner: "test/fixtures/miniprogram-runner.js",
          devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
        },
        { cwd: process.cwd(), execution },
      );

      assert.equal(result.status, "error");
      assert.match(result.errorReason ?? "", testCase.match);
    });
  }
});

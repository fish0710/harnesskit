import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

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
    {
      name: "runner Windows drive relative",
      projectPath: "test/fixtures/mp-project",
      runner: "C:outside",
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
  assert.deepEqual(calls[0]!.args, [resolve(process.cwd(), "test/fixtures/miniprogram-runner.js")]);
  assert.deepEqual(Object.keys(calls[0]!.env ?? {}).sort(), [
    "HARNESS_MINIPROGRAM_PROJECT",
    "HARNESS_MINIPROGRAM_PROJECT_ABS",
    "HARNESS_MINIPROGRAM_WS_ENDPOINT",
  ]);
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, "test/fixtures/mp-project");
  assert.equal(
    calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT_ABS,
    resolve(process.cwd(), "test/fixtures/mp-project"),
  );
  assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:9420");
});

test("miniprogram plugin executes accepted in-workspace symlinks by real path", async () => {
  const projectReal = mkdtempSync(`${process.cwd()}/test/fixtures/mp-project-real-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-real-link-`);
  try {
    const runnerReal = `${linkDir}/runner-real.js`;
    writeFileSync(`${projectReal}/project.config.json`, "{}\n");
    writeFileSync(runnerReal, "process.exit(0)\n");
    symlinkSync(projectReal, `${linkDir}/project-link`);
    symlinkSync(runnerReal, `${linkDir}/runner-link.js`);

    const projectPath = relative(process.cwd(), `${linkDir}/project-link`);
    const runnerPath = relative(process.cwd(), `${linkDir}/runner-link.js`);
    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.symlink.accepted",
        type: "miniprogram",
        projectPath,
        runner: runnerPath,
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "pass");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, [runnerReal]);
    assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT, projectPath);
    assert.equal(calls[0]!.env?.HARNESS_MINIPROGRAM_PROJECT_ABS, projectReal);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(projectReal, { recursive: true, force: true });
  }
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

test("miniprogram plugin rejects a file project path before execution", async () => {
  const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.project.file",
      type: "miniprogram",
      projectPath: "test/fixtures/miniprogram-runner.js",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /项目目录|directory|目录/);
  assert.equal(calls.length, 0);
});

test("miniprogram plugin rejects a directory project.config.json before execution", async () => {
  const projectAbs = mkdtempSync(`${process.cwd()}/test/fixtures/mp-config-dir-`);
  try {
    mkdirSync(`${projectAbs}/project.config.json`);
    const projectPath = relative(process.cwd(), projectAbs);
    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.project.config.directory",
        type: "miniprogram",
        projectPath,
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /project\.config\.json|配置|文件|file/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(projectAbs, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects runner symlink escape before execution", async () => {
  const outsideDir = mkdtempSync(`${tmpdir()}/mp-runner-outside-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-runner-link-`);
  try {
    const outsideRunner = `${outsideDir}/runner.js`;
    writeFileSync(outsideRunner, "process.exit(0)\n");
    symlinkSync(outsideRunner, `${linkDir}/runner.js`);

    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.runner.symlink.escape",
        type: "miniprogram",
        projectPath: "test/fixtures/mp-project",
        runner: relative(process.cwd(), `${linkDir}/runner.js`),
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /runner|工作区|workspace|越界|symlink|符号链接/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("miniprogram plugin rejects project path symlink escape before execution", async () => {
  const outsideProject = mkdtempSync(`${tmpdir()}/mp-project-outside-`);
  const linkDir = mkdtempSync(`${process.cwd()}/test/fixtures/mp-project-link-`);
  try {
    writeFileSync(`${outsideProject}/project.config.json`, "{}\n");
    symlinkSync(outsideProject, `${linkDir}/project`);

    const { execution, calls } = fakeExecution(() => ({ exitCode: 0 }));
    const result = await miniprogramPlugin.run(
      {
        id: "mp.project.symlink.escape",
        type: "miniprogram",
        projectPath: relative(process.cwd(), `${linkDir}/project`),
        runner: "test/fixtures/miniprogram-runner.js",
        devtools: { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
      },
      { cwd: process.cwd(), execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /项目|工作区|workspace|越界|symlink|符号链接/i);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(outsideProject, { recursive: true, force: true });
  }
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

test("miniprogram plugin starts managed DevTools before runner", async () => {
  const { execution, calls } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 0 : 0,
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.managed",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
        trustProject: true,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.command, "/Applications/WeChatDevTools/cli");
  assert.deepEqual(calls[0]!.args, [
    "auto",
    "--project",
    resolve(process.cwd(), "test/fixtures/mp-project"),
    "--auto-port",
    "19420",
    "--trust-project",
  ]);
  assert.deepEqual(calls[0]!.env, {});
  assert.equal(calls[1]!.env?.HARNESS_MINIPROGRAM_WS_ENDPOINT, "ws://127.0.0.1:19420");
  assert.equal(calls[1]!.env?.HARNESS_MINIPROGRAM_DEVTOOLS_PORT, "19420");
});

test("miniprogram plugin reports managed DevTools startup failure as error", async () => {
  const { execution } = fakeExecution((request) => ({
    exitCode: request.command === "/Applications/WeChatDevTools/cli" ? 2 : 0,
    stderr: request.command === "/Applications/WeChatDevTools/cli" ? "trust failed" : "",
  }));
  const result = await miniprogramPlugin.run(
    {
      id: "mp.devtools-error",
      type: "miniprogram",
      projectPath: "test/fixtures/mp-project",
      runner: "test/fixtures/miniprogram-runner.js",
      devtools: {
        mode: "managed",
        cliPath: "/Applications/WeChatDevTools/cli",
        autoPort: 19420,
      },
    },
    { cwd: process.cwd(), execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /DevTools|trust failed|退出码 2/);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  CommandExecutionRequest,
  ExecutionTarget,
  HttpExecutionRequest,
} from "../src/harness/execution.js";
import { bootPlugin } from "../src/plugins/boot.js";
import { commandPlugin } from "../src/plugins/command.js";
import { httpPlugin } from "../src/plugins/http.js";
import { structurePlugin } from "../src/plugins/structure.js";

function unusedRequest(): Promise<never> {
  return Promise.reject(new Error("HTTP execution was not expected"));
}

function unusedExecute(): Promise<never> {
  return Promise.reject(new Error("command execution was not expected"));
}

test("command plugin sends trusted execution request and host classifies exit 0 as pass", async () => {
  let call: CommandExecutionRequest | undefined;
  const execution: ExecutionTarget = {
    async execute(request) {
      call = request;
      return {
        executionId: request.executionId,
        exitCode: 0,
        stdout: "remote output",
        stderr: "",
        durationMs: 12,
      };
    },
    request: unusedRequest,
  };

  const result = await commandPlugin.run(
    { id: "command.remote", type: "command", cmd: "node", args: ["trusted-test.js"] },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "pass");
  assert.ok(call);
  assert.ok(call.executionId);
  assert.equal(call.command, "node");
  assert.deepEqual(call.args, ["trusted-test.js"]);
  assert.equal(call.cwd, "/workspace/candidate");
});

test("command plugin rejects mismatched evidence execution id", async () => {
  const execution: ExecutionTarget = {
    async execute() {
      return {
        executionId: "forged",
        exitCode: 0,
        stdout: "pass",
        stderr: "",
        durationMs: 1,
      };
    },
    request: unusedRequest,
  };

  const result = await commandPlugin.run(
    { id: "command.mismatch", type: "command", cmd: "true" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /ID|不匹配|不可信/);
});

test("command plugin classifies execution target error as error", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 3,
        error: "remote spawn failed",
      };
    },
    request: unusedRequest,
  };

  const result = await commandPlugin.run(
    { id: "command.error", type: "command", cmd: "missing" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /remote spawn failed/);
});

test("local command execution preserves RunContext cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await commandPlugin.run(
    { id: "command.cancelled", type: "command", cmd: "sleep", args: ["1"] },
    { cwd: process.cwd(), signal: controller.signal },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /abort/i);
});

test("boot plugin classifies remote duration on the host", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 25,
      };
    },
    request: unusedRequest,
  };

  const result = await bootPlugin.run(
    { id: "boot.remote", type: "boot", cmd: "service", expect: { startup_ms_lte: 10 } },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.what ?? "", /25ms/);
});

test("structure plugin uses remote stdout in host diagnostics", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: 1,
        stdout: "src/app.ts: forbidden import",
        stderr: "",
        durationMs: 8,
      };
    },
    request: unusedRequest,
  };

  const result = await structurePlugin.run(
    { id: "structure.remote", type: "structure", tool: "import-linter" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.how ?? "", /forbidden import/);
});

test("http plugin sends resolved trusted request and host classifies raw evidence", async () => {
  let call: HttpExecutionRequest | undefined;
  const execution: ExecutionTarget = {
    execute: unusedExecute,
    async request(request) {
      call = request;
      return {
        executionId: request.executionId,
        status: 201,
        headers: { "content-type": "application/json", "x-gate": "remote" },
        body: JSON.stringify({ created: true }),
        durationMs: 9,
      };
    },
  };

  const result = await httpPlugin.run(
    {
      id: "http.remote",
      type: "http",
      trigger: {
        method: "POST",
        baseUrl: "https://candidate.example",
        path: "/items",
        headers: { authorization: "trusted" },
        body: { name: "item" },
      },
      expect: {
        status: 201,
        headers: { "x-gate": "remote" },
        body_contains: { created: true },
      },
    },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "pass");
  assert.ok(call);
  assert.ok(call.executionId);
  assert.equal(call.url, "https://candidate.example/items");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.headers, { authorization: "trusted" });
  assert.equal(call.body, JSON.stringify({ name: "item" }));
});

test("http plugin rejects mismatched evidence id and target errors", async (t) => {
  await t.test("mismatched id", async () => {
    const execution: ExecutionTarget = {
      execute: unusedExecute,
      async request() {
        return {
          executionId: "forged",
          status: 200,
          headers: {},
          body: "ok",
          durationMs: 1,
        };
      },
    };

    const result = await httpPlugin.run(
      { id: "http.mismatch", type: "http", trigger: { url: "https://candidate.example" } },
      { cwd: "/workspace/candidate", execution },
    );

    assert.equal(result.status, "error");
  });

  await t.test("target error", async () => {
    const execution: ExecutionTarget = {
      execute: unusedExecute,
      async request(request) {
        return {
          executionId: request.executionId,
          headers: {},
          body: "",
          durationMs: 2,
          error: "remote timeout",
        };
      },
    };

    const result = await httpPlugin.run(
      { id: "http.error", type: "http", trigger: { url: "https://candidate.example" } },
      { cwd: "/workspace/candidate", execution },
    );

    assert.equal(result.status, "error");
    assert.match(result.errorReason ?? "", /remote timeout/);
  });
});

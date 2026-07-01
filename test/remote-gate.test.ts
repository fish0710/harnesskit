import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  CommandExecutionRequest,
  ExecutionTarget,
  HttpExecutionRequest,
} from "../src/harness/execution.js";
import {
  commandEvidenceError,
  localExecutionTarget,
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

test("command evidence accepts large safe codes and rejects unsafe integers", () => {
  const evidence = {
    executionId: "domain",
    exitCode: 512,
    stdout: "",
    stderr: "",
    durationMs: 1,
  };

  assert.equal(commandEvidenceError("domain", evidence), undefined);
  assert.ok(commandEvidenceError("domain", {
    ...evidence,
    exitCode: Number.MAX_SAFE_INTEGER + 1,
  }));
});

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
    {
      id: "command.remote",
      type: "command",
      cmd: "node",
      args: ["trusted-test.js"],
      timeoutMs: 2500,
    },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "pass");
  assert.ok(call);
  assert.ok(call.executionId);
  assert.equal(call.command, "node");
  assert.deepEqual(call.args, ["trusted-test.js"]);
  assert.equal(call.cwd, "/workspace/candidate");
  assert.equal(call.timeoutMs, 2500);
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

test("command plugin rejects null exit code without an execution error", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 3,
      };
    },
    request: unusedRequest,
  };

  const result = await commandPlugin.run(
    { id: "command.incomplete", type: "command", cmd: "node" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "error");
  assert.match(result.errorReason ?? "", /退出码|证据|不可信/);
});

test("command plugin rejects invalid finite exit code domains", async (t) => {
  for (const exitCode of [-1, 0.5]) {
    await t.test(String(exitCode), async () => {
      const execution: ExecutionTarget = {
        async execute(request) {
          return {
            executionId: request.executionId,
            exitCode,
            stdout: "",
            stderr: "",
            durationMs: 1,
          };
        },
        request: unusedRequest,
      };

      const result = await commandPlugin.run(
        { id: `command.invalid.${exitCode}`, type: "command", cmd: "node" },
        { cwd: "/workspace/candidate", execution },
      );

      assert.equal(result.status, "error");
    });
  }
});

test("command failure diagnostics include stdout when stderr is empty", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: 1,
        stdout: "assertion failed in trusted test",
        stderr: "",
        durationMs: 4,
      };
    },
    request: unusedRequest,
  };

  const result = await commandPlugin.run(
    { id: "command.stdout", type: "command", cmd: "node" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "fail");
  assert.match(result.violations[0]?.how ?? "", /assertion failed in trusted test/);
});

test("local command execution enforces timeout as error evidence", async () => {
  const start = performance.now();
  const evidence = await localExecutionTarget.execute({
    executionId: "local-timeout",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    cwd: process.cwd(),
    timeoutMs: 20,
  });
  const elapsed = performance.now() - start;

  assert.equal(evidence.executionId, "local-timeout");
  assert.ok(evidence.error);
  assert.equal(evidence.exitCode, null);
  assert.ok(elapsed < 500, `timeout took ${elapsed.toFixed(0)}ms`);
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

test("local command execution returns error evidence when cancelled after start", async () => {
  const controller = new AbortController();
  const start = performance.now();
  const pending = localExecutionTarget.execute({
    executionId: "local-cancel-mid-execution",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    cwd: process.cwd(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  const evidence = await pending;
  const elapsed = performance.now() - start;

  assert.ok(evidence.error);
  assert.equal(evidence.exitCode, null);
  assert.ok(elapsed < 500, `cancellation took ${elapsed.toFixed(0)}ms`);
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

test("boot plugin rejects null exit code even within startup budget", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    },
    request: unusedRequest,
  };

  const result = await bootPlugin.run(
    { id: "boot.incomplete", type: "boot", cmd: "service", expect: { startup_ms_lte: 100 } },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "error");
});

test("boot plugin rejects invalid finite exit code domains", async (t) => {
  for (const exitCode of [-1, 0.5]) {
    await t.test(String(exitCode), async () => {
      const execution: ExecutionTarget = {
        async execute(request) {
          return {
            executionId: request.executionId,
            exitCode,
            stdout: "",
            stderr: "",
            durationMs: 1,
          };
        },
        request: unusedRequest,
      };

      const result = await bootPlugin.run(
        {
          id: `boot.invalid.${exitCode}`,
          type: "boot",
          cmd: "service",
          expect: { startup_ms_lte: 100 },
        },
        { cwd: "/workspace/candidate", execution },
      );

      assert.equal(result.status, "error");
    });
  }
});

test("boot plugin rejects invalid duration evidence domains", async (t) => {
  const invalidDurations: unknown[] = [-1, Infinity, NaN, "1"];
  for (const durationMs of invalidDurations) {
    await t.test(String(durationMs), async () => {
      const execution: ExecutionTarget = {
        async execute(request) {
          return {
            executionId: request.executionId,
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: durationMs as number,
          };
        },
        request: unusedRequest,
      };

      const result = await bootPlugin.run(
        {
          id: `boot.invalid-duration.${String(durationMs)}`,
          type: "boot",
          cmd: "service",
          expect: { startup_ms_lte: 100 },
        },
        { cwd: "/workspace/candidate", execution },
      );

      assert.equal(result.status, "error");
    });
  }
});

test("boot plugin accepts fractional nonnegative duration evidence", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0.5,
      };
    },
    request: unusedRequest,
  };

  const result = await bootPlugin.run(
    { id: "boot.fractional-duration", type: "boot", cmd: "service" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "pass");
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

test("structure plugin rejects null exit code without an execution error", async () => {
  const execution: ExecutionTarget = {
    async execute(request) {
      return {
        executionId: request.executionId,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 2,
      };
    },
    request: unusedRequest,
  };

  const result = await structurePlugin.run(
    { id: "structure.incomplete", type: "structure", tool: "import-linter" },
    { cwd: "/workspace/candidate", execution },
  );

  assert.equal(result.status, "error");
});

test("structure plugin rejects invalid finite exit code domains", async (t) => {
  for (const exitCode of [-1, 0.5]) {
    await t.test(String(exitCode), async () => {
      const execution: ExecutionTarget = {
        async execute(request) {
          return {
            executionId: request.executionId,
            exitCode,
            stdout: "",
            stderr: "",
            durationMs: 1,
          };
        },
        request: unusedRequest,
      };

      const result = await structurePlugin.run(
        { id: `structure.invalid.${exitCode}`, type: "structure", tool: "import-linter" },
        { cwd: "/workspace/candidate", execution },
      );

      assert.equal(result.status, "error");
    });
  }
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

  await t.test("nonnumeric status", async () => {
    const execution: ExecutionTarget = {
      execute: unusedExecute,
      async request(request) {
        return {
          executionId: request.executionId,
          status: null as unknown as number,
          headers: {},
          body: "ok",
          durationMs: 1,
        };
      },
    };

    const result = await httpPlugin.run(
      { id: "http.incomplete", type: "http", trigger: { url: "https://candidate.example" } },
      { cwd: "/workspace/candidate", execution },
    );

    assert.equal(result.status, "error");
  });

  for (const status of [99, 200.5, 600]) {
    await t.test(`invalid status ${status}`, async () => {
      const execution: ExecutionTarget = {
        execute: unusedExecute,
        async request(request) {
          return {
            executionId: request.executionId,
            status,
            headers: {},
            body: "ok",
            durationMs: 1,
          };
        },
      };

      const result = await httpPlugin.run(
        { id: `http.invalid.${status}`, type: "http", trigger: { url: "https://candidate.example" } },
        { cwd: "/workspace/candidate", execution },
      );

      assert.equal(result.status, "error");
    });
  }

  await t.test("invalid duration", async () => {
    const execution: ExecutionTarget = {
      execute: unusedExecute,
      async request(request) {
        return {
          executionId: request.executionId,
          status: 200,
          headers: {},
          body: "ok",
          durationMs: -1,
        };
      },
    };

    const result = await httpPlugin.run(
      { id: "http.invalid-duration", type: "http", trigger: { url: "https://candidate.example" } },
      { cwd: "/workspace/candidate", execution },
    );

    assert.equal(result.status, "error");
  });
});

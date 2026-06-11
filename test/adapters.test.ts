import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { httpPlugin } from "../src/plugins/http.js";
import { structurePlugin } from "../src/plugins/structure.js";
import { createInvariantPlugin } from "../src/plugins/invariant.js";
import type { Contract, RunContext } from "../src/types.js";

const ctx: RunContext = { cwd: process.cwd() };

// ---------- http: 用临时服务器真实验证 ----------
function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, server });
    });
  });
}

test("http: 状态码与字段都符 → pass", async () => {
  let received = "";
  const { base, server } = await startServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "trusted");
    req.setEncoding("utf8");
    req.on("data", (chunk) => { received += chunk; });
    req.on("end", () => {
      assert.equal(received, JSON.stringify({ amount: -1 }));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_code: "INVALID_AMOUNT" }));
    });
  });
  try {
    const c: Contract = {
      id: "h.pass", type: "http",
      trigger: {
        method: "POST",
        baseUrl: base,
        path: "/payments",
        headers: { authorization: "trusted" },
        body: { amount: -1 },
      },
      expect: { status: 400, body_contains: { error_code: "INVALID_AMOUNT" } },
    };
    const r = await httpPlugin.run(c, ctx);
    assert.equal(r.status, "pass");
    assert.equal(received, JSON.stringify({ amount: -1 }));
  } finally {
    server.close();
  }
});

test("http: 状态码不符 → fail", async () => {
  const { base, server } = await startServer((_req, res) => { res.writeHead(201); res.end("{}"); });
  try {
    const c: Contract = { id: "h.fail", type: "http", trigger: { baseUrl: base, path: "/x" }, expect: { status: 400 } };
    const r = await httpPlugin.run(c, ctx);
    assert.equal(r.status, "fail");
    assert.match(r.violations[0]!.what, /状态码/);
  } finally {
    server.close();
  }
});

test("http: 连不上(服务没起) → error,不是 fail", async () => {
  // 端口 1 几乎必然连不上
  const c: Contract = { id: "h.err", type: "http", trigger: { url: "http://127.0.0.1:1/x" }, expect: { status: 200 } };
  const r = await httpPlugin.run(c, ctx);
  assert.equal(r.status, "error");
  assert.match(r.errorReason ?? "", /连不上|失败/);
});

test("http: 无法解析 URL → error", async () => {
  const r = await httpPlugin.run({ id: "h.nourl", type: "http", trigger: {} }, ctx);
  assert.equal(r.status, "error");
});

// ---------- structure: 委托子进程 ----------
test("structure: 工具退出 0 → pass", async () => {
  const r = await structurePlugin.run({ id: "s.ok", type: "structure", tool: "true" }, ctx);
  assert.equal(r.status, "pass");
});
test("structure: 工具非零退出 → fail", async () => {
  const r = await structurePlugin.run({ id: "s.fail", type: "structure", tool: "false" }, ctx);
  assert.equal(r.status, "fail");
});
test("structure: 工具没装(起不来) → error,不是 fail", async () => {
  const r = await structurePlugin.run({ id: "s.err", type: "structure", tool: "no-linter-xyz-123" }, ctx);
  assert.equal(r.status, "error");
  assert.match(r.errorReason ?? "", /无法启动|未安装/);
});

// ---------- invariant: 属性测试 ----------
const isPrimeCorrect = (n: number) => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
const isPrimeBuggy = (n: number) => { if (n < 2) return false; for (let i = 2; i * i < n; i++) if (n % i === 0) return false; return true; }; // i*i<n 漏等号
const trialDiv = isPrimeCorrect;

test("invariant: 正确属性 → pass", async () => {
  const p = createInvariantPlugin({ prime_consistent: (n) => isPrimeCorrect(n as number) === trialDiv(n as number) });
  const r = await p.run({ id: "i.ok", type: "invariant", property: "prime_consistent", trigger: { generator: "integers", samples: 300, min: 0, max: 100 } }, ctx);
  assert.equal(r.status, "pass");
});
test("invariant: 有 bug 的属性 → fail(找到反例,如完全平方数)", async () => {
  const p = createInvariantPlugin({ prime_buggy: (n) => isPrimeBuggy(n as number) === trialDiv(n as number) });
  const r = await p.run({ id: "i.fail", type: "invariant", property: "prime_buggy", trigger: { generator: "integers", samples: 300, min: 0, max: 100 } }, ctx);
  assert.equal(r.status, "fail");
  assert.match(r.violations[0]!.what, /反例/);
});
test("invariant: 属性未注册 → error", async () => {
  const p = createInvariantPlugin({});
  const r = await p.run({ id: "i.err", type: "invariant", property: "ghost" }, ctx);
  assert.equal(r.status, "error");
});
test("invariant: 属性抛异常 → fail(crash 反例)", async () => {
  const p = createInvariantPlugin({ boom: (n) => { if ((n as number) === 1) throw new Error("crash on 1"); return true; } });
  const r = await p.run({ id: "i.boom", type: "invariant", property: "boom", trigger: { generator: "integers" } }, ctx);
  assert.equal(r.status, "fail");
  assert.match(r.violations[0]!.what, /抛异常/);
});

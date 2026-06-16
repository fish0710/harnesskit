import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("CLI check registers and runs miniprogram contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-miniprogram-cli-"));
  write(
    join(root, "contracts/mp.yaml"),
    [
      "id: mp.cli",
      "type: miniprogram",
      "projectPath: dist/dev/mp-weixin",
      "runner: test/gates/miniprogram-runner.js",
      "devtools:",
      "  mode: connect",
      "  wsEndpoint: ws://127.0.0.1:9420",
      "",
    ].join("\n"),
  );
  write(join(root, "dist/dev/mp-weixin/project.config.json"), "{}\n");
  write(join(root, "test/gates/miniprogram-runner.js"), "process.exit(0);\n");

  const result = spawnSync(
    process.execPath,
    [cliPath, "check", "--dir", "contracts", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"id": "mp\.cli"/);
  assert.match(result.stdout, /"status": "pass"/);
});

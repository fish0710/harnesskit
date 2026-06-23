import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI runs when invoked through a bin symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-cli-bin-"));
  const binPath = join(dir, "harness");
  symlinkSync(cliPath, binPath);

  const result = spawnSync(binPath, ["--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /harness — 完整门禁 \+ 产出引擎 CLI/);
});

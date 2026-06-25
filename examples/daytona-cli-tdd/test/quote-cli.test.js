import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runQuote(args) {
  return spawnSync(process.execPath, ["bin/quote.js", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}

test("prints quoted text", () => {
  const result = runQuote(["--text", "hello world"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "\"hello world\"");
  assert.equal(result.stderr.trim(), "");
});

test("uppercases before quoting when --upper is present", () => {
  const result = runQuote(["--text", "needs spaces", "--upper"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "\"NEEDS SPACES\"");
  assert.equal(result.stderr.trim(), "");
});

test("missing --text exits with usage error", () => {
  const result = runQuote(["--upper"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: quote --text <value> \[--upper\]/);
  assert.equal(result.stdout.trim(), "");
});

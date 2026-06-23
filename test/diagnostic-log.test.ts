import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDiagnosticLogger,
  diagnosticLogPath,
} from "../src/harness/diagnostic-log.js";
import { redactObservationData } from "../src/harness/redaction.js";

test("disabled diagnostic logger is silent and has no path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-diagnostic-log-disabled-"));
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    enabled: false,
    cwd,
    runId: "run-1",
    write: (line) => lines.push(line),
    now: () => "2026-06-23T00:00:00.000Z",
    redact: redactObservationData,
  });

  logger.info("run.setup", "ignored", { token: "secret" });
  logger.close();

  assert.equal(logger.enabled, false);
  assert.equal(logger.path, undefined);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(diagnosticLogPath(cwd, "run-1")), false);
});

test("enabled diagnostic logger writes redacted JSONL and compact output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-diagnostic-log-enabled-"));
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    enabled: true,
    cwd,
    runId: "run-2",
    write: (line) => lines.push(line),
    now: () => "2026-06-23T00:00:00.000Z",
    redact: redactObservationData,
  });

  logger.debug("run.setup", "agent selected", {
    kind: "claude",
    apiKey: "secret",
    nested: { cookie: "session" },
  });
  logger.close();

  assert.equal(logger.enabled, true);
  assert.equal(logger.path, diagnosticLogPath(cwd, "run-2"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /debug run\.setup agent selected/);
  assert.match(lines[0]!, /"apiKey":"\[redacted\]"/);
  assert.doesNotMatch(lines[0]!, /secret|session/);

  const entries = readFileSync(logger.path!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as {
      at: string;
      level: string;
      phase: string;
      message: string;
      data: { kind?: string; apiKey?: string; nested?: { cookie?: string } };
    });
  assert.deepEqual(entries, [
    {
      at: "2026-06-23T00:00:00.000Z",
      level: "debug",
      phase: "run.setup",
      message: "agent selected",
      data: {
        kind: "claude",
        apiKey: "[redacted]",
        nested: { cookie: "[redacted]" },
      },
    },
  ]);
});

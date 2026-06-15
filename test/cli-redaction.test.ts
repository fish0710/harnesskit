import assert from "node:assert/strict";
import { test } from "node:test";

import { redactObservationData } from "../src/cli.js";

test("CLI observation redaction masks nested secret-like keys before JSON output", () => {
  const circular: Record<string, unknown> = { keep: "visible" };
  circular.self = circular;

  const redacted = redactObservationData({
    id: "sandbox-1",
    nested: {
      apiKey: "daytona-key",
      token: "model-token",
      authorization: "Bearer secret",
      auth: { password: "pw", ok: true },
    },
    array: [
      { cookie: "session=value" },
      { api_key: "snake-key" },
      "plain",
    ],
    circular,
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("daytona-key"), false);
  assert.equal(serialized.includes("model-token"), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(serialized.includes("session=value"), false);
  assert.equal(serialized.includes("snake-key"), false);
  assert.match(serialized, /"apiKey":"\[redacted\]"/);
  assert.match(serialized, /"token":"\[redacted\]"/);
  assert.match(serialized, /"authorization":"\[redacted\]"/);
  assert.match(serialized, /"cookie":"\[redacted\]"/);
  assert.match(serialized, /"self":"\[circular\]"/);
  assert.match(serialized, /"id":"sandbox-1"/);
});

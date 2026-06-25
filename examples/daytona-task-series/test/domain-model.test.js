import { test } from "node:test";
import assert from "node:assert/strict";

import { createOrder } from "../src/domain-model.js";

test("creates an order in created state", () => {
  assert.deepEqual(createOrder("ord_100", 2599), {
    id: "ord_100",
    status: "created",
    totalCents: 2599,
  });
});

test("rejects blank order ids", () => {
  assert.throws(() => createOrder("", 100), /id/i);
  assert.throws(() => createOrder("   ", 100), /id/i);
});

test("rejects negative totals", () => {
  assert.throws(() => createOrder("ord_bad", -1), /totalCents/i);
});

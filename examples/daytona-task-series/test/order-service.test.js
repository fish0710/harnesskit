import { test } from "node:test";
import assert from "node:assert/strict";

import { createOrderService } from "../src/order-service.js";

test("creates orders through the domain model", () => {
  const service = createOrderService();

  assert.deepEqual(service.create("ord_200", 5000), {
    id: "ord_200",
    status: "created",
    totalCents: 5000,
  });
});

test("marks created orders as paid without mutating the original", () => {
  const service = createOrderService();
  const order = service.create("ord_201", 1200);

  const paid = service.markPaid(order);

  assert.deepEqual(paid, {
    id: "ord_201",
    status: "paid",
    totalCents: 1200,
  });
  assert.equal(order.status, "created");
});

test("rejects payment for orders that are not created", () => {
  const service = createOrderService();

  assert.throws(
    () => service.markPaid({ id: "ord_202", status: "cancelled", totalCents: 100 }),
    /created/i,
  );
});

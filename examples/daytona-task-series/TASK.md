# Task series: order workflow

Harness runs this example as a configured task series. Do not pass a positional
task to `harness run`; the tasks are defined in `harness.config.json`.

## Task 1: define the domain model

Update `examples/daytona-task-series/src/domain-model.js`.

Requirements:

- Export `createOrder(id, totalCents)`.
- Return `{ id, status: "created", totalCents }`.
- Reject blank or whitespace-only ids with an error mentioning `id`.
- Reject negative `totalCents` with an error mentioning `totalCents`.
- Use Node.js built-ins only.

## Task 2: implement the order service

Update `examples/daytona-task-series/src/order-service.js`.

Requirements:

- Export `createOrderService()`.
- `createOrderService().create(id, totalCents)` must create orders through
  `createOrder`.
- `createOrderService().markPaid(order)` must return a new order object with
  status `"paid"`.
- `markPaid` must not mutate the original order.
- `markPaid` must reject any order whose current status is not `"created"` with
  an error mentioning `created`.

Your working area:

- You may edit only files under `examples/daytona-task-series/src`.
- The protected tests under `examples/daytona-task-series/test` are read-only
  context and must not be changed.
- Do not read or edit protected Harness files under
  `examples/daytona-task-series/contracts` or
  `examples/daytona-task-series/harness.config.json`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { GateCore } from "../src/gate.js";
import { miniprogramPlugin } from "../src/plugins/miniprogram.js";

test("miniprogram plugin registers under a stable type", () => {
  const gate = new GateCore().use(miniprogramPlugin);
  assert.deepEqual(gate.plugins(), ["miniprogram"]);
});

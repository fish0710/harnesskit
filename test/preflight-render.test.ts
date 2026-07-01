import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gatePreflightRunBlocker,
  renderGatePreflightJson,
  renderGatePreflightPretty,
  type GatePreflightReport,
} from "../src/harness/preflight.js";

function reportFixture(): GatePreflightReport {
  return {
    outcome: "not_ready",
    staticFindings: [
      {
        id: "gateSetup.1.nvm",
        severity: "error",
        message: "Gate setup uses bare nvm.",
        source: "static",
      },
    ],
    setup: [
      {
        label: "gateSetup.1",
        command: "npm ci",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
    ],
    selectedContracts: ["command.smoke"],
    remoteContracts: ["command.smoke"],
    hostLocalContracts: [],
    readinessErrors: [
      {
        id: "contract.command.smoke.runtime",
        severity: "error",
        message: "node: command not found",
        source: "contract",
        contractId: "command.smoke",
      },
    ],
    productFailures: ["domain.regression"],
    sandbox: {
      id: "sandbox-123",
      snapshot: "gate-snapshot",
      retained: true,
    },
  };
}

test("renderGatePreflightJson emits stable formatted report JSON", () => {
  const rendered = renderGatePreflightJson(reportFixture());
  const parsed = JSON.parse(rendered) as GatePreflightReport;

  assert.equal(parsed.outcome, "not_ready");
  assert.deepEqual(parsed.selectedContracts, ["command.smoke"]);
  assert.equal(parsed.sandbox?.retained, true);
  assert.match(rendered, /\n  "outcome": "not_ready"/);
});

test("renderGatePreflightPretty summarizes readiness, setup, and product details", () => {
  const rendered = renderGatePreflightPretty(reportFixture());

  assert.match(rendered, /Harness Gate Preflight/);
  assert.match(rendered, /selected 1 contracts; remote 1/);
  assert.match(rendered, /outcome: not_ready/);
  assert.match(rendered, /sandbox: sandbox-123 snapshot=gate-snapshot retained=true/);
  assert.match(rendered, /\[error\] gateSetup\.1\.nvm: Gate setup uses bare nvm\./);
  assert.match(rendered, /\[setup\] gateSetup\.1 exit=0: npm ci/);
  assert.match(rendered, /\[readiness\] contract\.command\.smoke\.runtime: node: command not found/);
  assert.match(rendered, /\[product-red\] domain\.regression/);
  assert.doesNotMatch(rendered, /host-local/);
});

test("gatePreflightRunBlocker blocks readiness errors with actionable details", () => {
  const blocker = gatePreflightRunBlocker(reportFixture());

  assert.match(blocker ?? "", /Gate preflight readiness failed/);
  assert.match(blocker ?? "", /contract\.command\.smoke\.runtime/);
  assert.match(blocker ?? "", /node: command not found/);
});

test("gatePreflightRunBlocker allows product-red reports without readiness errors", () => {
  const report = reportFixture();
  report.readinessErrors = [];
  report.productFailures = ["domain.regression"];

  assert.equal(gatePreflightRunBlocker(report), undefined);
});

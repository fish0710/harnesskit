import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
  buildRunId,
  claudeObservabilityPaths,
  loadDaytonaObservabilityConfig,
} from "../src/harness/observability.js";

test("Daytona Claude observability is default-on with stable defaults", () => {
  const config = loadDaytonaObservabilityConfig({});

  assert.deepEqual(config, {
    enabled: true,
    backend: "daytona-volume",
    volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
    mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  });
});

test("Daytona Claude observability can be explicitly disabled", () => {
  for (const value of ["0", "false", "off", " FALSE "]) {
    const config = loadDaytonaObservabilityConfig({
      HARNESS_DAYTONA_OBSERVABILITY: value,
    });

    assert.equal(config.enabled, false);
    assert.equal(config.backend, "disabled");
    assert.equal(config.volumeName, DEFAULT_DAYTONA_OBSERVABILITY_VOLUME);
    assert.equal(config.mountPath, DEFAULT_DAYTONA_OBSERVABILITY_MOUNT);
  }
});

test("Daytona Claude observability disable flag ignores stale invalid volume settings", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY: "0",
    HARNESS_DAYTONA_OBSERVABILITY_VOLUME: "   ",
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "relative/path",
  });

  assert.deepEqual(config, {
    enabled: false,
    backend: "disabled",
    volumeName: DEFAULT_DAYTONA_OBSERVABILITY_VOLUME,
    mountPath: DEFAULT_DAYTONA_OBSERVABILITY_MOUNT,
  });
});

test("Daytona Claude observability rejects blank volume names and unsafe mounts", () => {
  assert.throws(
    () =>
      loadDaytonaObservabilityConfig({
        HARNESS_DAYTONA_OBSERVABILITY_VOLUME: "   ",
      }),
    /HARNESS_DAYTONA_OBSERVABILITY_VOLUME/,
  );

  for (const mountPath of ["", "relative/path", "/", "/tmp/\0bad"]) {
    assert.throws(
      () =>
        loadDaytonaObservabilityConfig({
          HARNESS_DAYTONA_OBSERVABILITY_MOUNT: mountPath,
        }),
      /HARNESS_DAYTONA_OBSERVABILITY_MOUNT/,
    );
  }
});

test("buildRunId produces filesystem-safe sortable ids", () => {
  const runId = buildRunId(
    new Date("2026-06-16T12:00:00.123Z"),
    () => "12345678-90ab-cdef-1234-567890abcdef",
  );

  assert.equal(runId, "2026-06-16T12-00-00-123Z-12345678");
  assert.equal(runId.includes(":"), false);
  assert.equal(runId.includes("."), false);
});

test("buildRunId sanitizes caller-provided random id suffixes", () => {
  const runId = buildRunId(
    new Date("2026-06-16T12:00:00.123Z"),
    () => "../bad-id!@#456789",
  );

  assert.equal(runId, "2026-06-16T12-00-00-123Z-badid456");
  assert.equal(runId.includes("/"), false);
  assert.equal(runId.includes("!"), false);
});

test("claudeObservabilityPaths builds attempt scoped Claude config paths", () => {
  const config = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY_MOUNT: "/harness-observability/",
  });

  const paths = claudeObservabilityPaths(config, "run-1", 2);

  assert.deepEqual(paths, {
    runRoot: "/harness-observability/runs/run-1",
    attemptRoot: "/harness-observability/runs/run-1/attempt-2",
    claudeConfigDir: "/harness-observability/runs/run-1/attempt-2/.claude",
    manifestPath: "/harness-observability/runs/run-1/attempt-2/manifest.json",
  });
});

test("claudeObservabilityPaths rejects disabled config and invalid attempts", () => {
  const disabled = loadDaytonaObservabilityConfig({
    HARNESS_DAYTONA_OBSERVABILITY: "0",
  });

  assert.throws(
    () => claudeObservabilityPaths(disabled, "run-1", 1),
    /disabled/,
  );
  assert.throws(
    () =>
      claudeObservabilityPaths(
        loadDaytonaObservabilityConfig({}),
        "run-1",
        0,
      ),
    /attempt/,
  );
});

test("claudeObservabilityPaths rejects run ids that are not safe path segments", () => {
  const config = loadDaytonaObservabilityConfig({});

  for (const runId of ["", "../escape", "nested/run", "run\0id"]) {
    assert.throws(
      () => claudeObservabilityPaths(config, runId, 1),
      /runId/,
    );
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CLAUDE_COMMAND,
  configureLocalDaytonaProxy,
  getClaudeEnvironment,
  getDaytonaConfig,
  getLocalDaytonaNoProxy,
} from "../src/harness/sandbox/daytona.js";
import {
  createGitFixture,
  integrationPolicy,
  runDaytonaIntegration,
} from "./daytona-claude.js";

const claudeEnvironment = {
  ANTHROPIC_AUTH_TOKEN: "token with ' quote",
  ANTHROPIC_BASE_URL: "https://model.example.test",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
  ANTHROPIC_MODEL: "sonnet",
  ANTHROPIC_REASONING_MODEL: "reasoning",
};

test("Daytona configuration defaults to the local API and reads the API key", () => {
  assert.deepEqual(getDaytonaConfig({ DAYTONA_API_KEY: "local-key" }), {
    apiUrl: "http://localhost:3000/api",
    apiKey: "local-key",
  });
});

test("Daytona configuration accepts an explicit API URL", () => {
  assert.deepEqual(getDaytonaConfig({
    DAYTONA_API_URL: "https://daytona.example.test/api",
    DAYTONA_API_KEY: "remote-key",
  }), {
    apiUrl: "https://daytona.example.test/api",
    apiKey: "remote-key",
  });
});

test("Daytona configuration requires a nonempty API key", () => {
  assert.throws(
    () => getDaytonaConfig({}),
    /DAYTONA_API_KEY/,
  );
  assert.throws(
    () => getDaytonaConfig({ DAYTONA_API_KEY: "" }),
    /DAYTONA_API_KEY/,
  );
});

test("local Daytona and toolbox hosts are appended to NO_PROXY without duplicates", () => {
  assert.equal(
    getLocalDaytonaNoProxy("internal.example"),
    "internal.example,localhost,127.0.0.1,.localhost,proxy.localhost",
  );
  assert.equal(
    getLocalDaytonaNoProxy(" localhost, proxy.localhost,localhost "),
    "localhost,proxy.localhost,127.0.0.1,.localhost",
  );
});

test("proxy bypass updates both NO_PROXY spellings", () => {
  const environment: Record<string, string | undefined> = {
    NO_PROXY: "internal.example",
    no_proxy: "lower.example",
  };

  configureLocalDaytonaProxy(environment);

  assert.equal(
    environment.NO_PROXY,
    "internal.example,lower.example,localhost,127.0.0.1,.localhost,proxy.localhost",
  );
  assert.equal(environment.no_proxy, environment.NO_PROXY);
});

test("Claude environment is an exact model allowlist without ANTHROPIC_API_KEY", () => {
  const environment = getClaudeEnvironment({
    ...claudeEnvironment,
    ANTHROPIC_API_KEY: "must-not-be-forwarded",
    DAYTONA_API_KEY: "must-not-be-forwarded",
    HARNESS_GATE_SIGNING_KEY: "must-not-be-forwarded",
  });

  assert.deepEqual(environment, claudeEnvironment);
  assert.equal("ANTHROPIC_API_KEY" in environment, false);
  assert.equal("DAYTONA_API_KEY" in environment, false);
  assert.equal("HARNESS_GATE_SIGNING_KEY" in environment, false);
});

test("Claude environment derives optional run models from default model variables", () => {
  const {
    ANTHROPIC_MODEL: _model,
    ANTHROPIC_REASONING_MODEL: _reasoningModel,
    ...environment
  } = claudeEnvironment;

  assert.deepEqual(getClaudeEnvironment(environment), {
    ...environment,
    ANTHROPIC_MODEL: "sonnet",
    ANTHROPIC_REASONING_MODEL: "opus",
  });
});

test("Claude environment reports every missing required allowlisted variable", () => {
  const {
    ANTHROPIC_AUTH_TOKEN: _token,
    ANTHROPIC_MODEL: _model,
    ...incomplete
  } = claudeEnvironment;

  assert.throws(
    () => getClaudeEnvironment(incomplete),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ANTHROPIC_AUTH_TOKEN/);
      assert.doesNotMatch(error.message, /ANTHROPIC_MODEL/);
      return true;
    },
  );
});

test("Claude Code launches from the immutable image path", () => {
  assert.match(CLAUDE_COMMAND, /^exec "\/usr\/local\/bin\/claude"/);
  assert.match(CLAUDE_COMMAND, /--dangerously-skip-permissions/);
  assert.match(CLAUDE_COMMAND, /--output-format stream-json/);
  assert.match(CLAUDE_COMMAND, /--verbose/);
});

test("Daytona Claude integration policy installs dependencies in the Agent sandbox", () => {
  const policy = integrationPolicy();

  assert.deepEqual(policy.candidateRoots, [
    "src",
    "package.json",
    "package-lock.json",
  ]);
  assert.deepEqual(policy.protectedPaths, ["contracts", ".harness"]);
  assert.deepEqual(policy.agentSetup, ["npm install"]);
  assert.equal(policy.retainOnFailure, false);
});

test("Daytona Claude fixture includes an installable private package", () => {
  const root = createGitFixture();
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );

  assert.deepEqual(packageJson, {
    name: "harness-daytona-integration-fixture",
    version: "1.0.0",
    private: true,
  });
});

test("Daytona Claude integration rejects blank Agent snapshot overrides before running", async () => {
  await assert.rejects(
    () =>
      runDaytonaIntegration({
        RUN_DAYTONA_INTEGRATION: "1",
        DAYTONA_API_KEY: "unused",
        HARNESS_DAYTONA_AGENT_SNAPSHOT: "   ",
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_MODEL: "model",
      }),
    /HARNESS_DAYTONA_AGENT_SNAPSHOT/,
  );
});

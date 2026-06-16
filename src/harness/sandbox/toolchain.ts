import type { SandboxCommandResult } from "./types.js";

export const NODE_VERSION = "22.14.0";
export const CLAUDE_CODE_VERSION = "2.1.145";
export const DAYTONA_AGENT_RELEASE = `${CLAUDE_CODE_VERSION}-r2`;
export const DAYTONA_AGENT_IMAGE =
  `harness-daytona-claude:${DAYTONA_AGENT_RELEASE}`;
export const DAYTONA_AGENT_REGISTRY_IMAGE =
  `registry:6000/harness/${DAYTONA_AGENT_IMAGE}`;
export const DAYTONA_AGENT_SNAPSHOT =
  `harness-agent-claude-${DAYTONA_AGENT_RELEASE}`;
export const DAYTONA_AGENT_LATEST_SNAPSHOT = "harness-agent-claude-latest";

export const DAYTONA_GATE_RELEASE = `node-${NODE_VERSION}-r1`;
export const DAYTONA_GATE_IMAGE =
  `harness-daytona-gate:${DAYTONA_GATE_RELEASE}`;
export const DAYTONA_GATE_REGISTRY_IMAGE =
  `registry:6000/harness/${DAYTONA_GATE_IMAGE}`;
export const DAYTONA_GATE_SNAPSHOT =
  `harness-gate-runtime-${DAYTONA_GATE_RELEASE}`;
export const DAYTONA_GATE_LATEST_SNAPSHOT = "harness-gate-runtime-latest";

export const CLAUDE_TOOLCHAIN_PREFLIGHT = [
  "set -eu",
  'node_version=$("/usr/local/bin/node" --version)',
  'npm_version=$("/usr/local/bin/npm" --version)',
  'npx_version=$("/usr/local/bin/npx" --version)',
  'claude_version=$("/usr/local/bin/claude" --version)',
  'bash_path="$(command -v bash)"',
  'test "$bash_path" = "/usr/bin/bash"',
  'printf "node=%s\\nnpm=%s\\nnpx=%s\\nclaude=%s\\nbash=%s\\n" ' +
    '"$node_version" "$npm_version" "$npx_version" "$claude_version" ' +
    '"$bash_path"',
].join("; ");

type Environment = Record<string, string | undefined>;

export function assertClaudeToolchain(
  result: SandboxCommandResult,
): void {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `Claude toolchain preflight failed with exit ${result.exitCode}: ` +
        (output || "(no output)"),
    );
  }

  const node = /^node=v?([^\s]+)$/m.exec(result.stdout)?.[1];
  const npm = /^npm=([^\s]+)$/m.exec(result.stdout)?.[1];
  const npx = /^npx=([^\s]+)$/m.exec(result.stdout)?.[1];
  const claude = /^claude=([^\s]+)/m.exec(result.stdout)?.[1];
  const bash = /^bash=([^\s]+)$/m.exec(result.stdout)?.[1];
  if (node !== NODE_VERSION) {
    throw new Error(
      `Expected Node.js ${NODE_VERSION}, observed ${node ?? "missing"}`,
    );
  }
  if (!npm || !npx) {
    throw new Error(
      "Expected npm and npx in the Agent image, observed " +
        `npm=${npm ?? "missing"} npx=${npx ?? "missing"}`,
    );
  }
  if (claude !== CLAUDE_CODE_VERSION) {
    throw new Error(
      `Expected Claude Code ${CLAUDE_CODE_VERSION}, ` +
        `observed ${claude ?? "missing"}`,
    );
  }
  if (bash !== "/usr/bin/bash") {
    throw new Error(
      `Expected /usr/bin/bash for Daytona PTY startup, ` +
        `observed ${bash ?? "missing"}`,
    );
  }
}

export function requireAgentSnapshot(environment: Environment): string {
  if (environment.HARNESS_DAYTONA_AGENT_SNAPSHOT === undefined) {
    return DAYTONA_AGENT_LATEST_SNAPSHOT;
  }
  const snapshot = environment.HARNESS_DAYTONA_AGENT_SNAPSHOT.trim();
  if (!snapshot) {
    throw new Error(
      "HARNESS_DAYTONA_AGENT_SNAPSHOT must not be blank",
    );
  }
  return snapshot;
}

export function getGateSnapshot(environment: Environment): string {
  if (environment.HARNESS_DAYTONA_GATE_SNAPSHOT === undefined) {
    return DAYTONA_GATE_LATEST_SNAPSHOT;
  }
  const snapshot = environment.HARNESS_DAYTONA_GATE_SNAPSHOT.trim();
  if (!snapshot) {
    throw new Error(
      "HARNESS_DAYTONA_GATE_SNAPSHOT must not be blank",
    );
  }
  return snapshot;
}

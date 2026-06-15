import type { SandboxCommandResult } from "./types.js";

export const NODE_VERSION = "22.14.0";
export const CLAUDE_CODE_VERSION = "2.1.145";
export const DAYTONA_AGENT_RELEASE = `${CLAUDE_CODE_VERSION}-r1`;
export const DAYTONA_AGENT_IMAGE =
  `harness-daytona-claude:${DAYTONA_AGENT_RELEASE}`;
export const DAYTONA_AGENT_REGISTRY_IMAGE =
  `registry:6000/harness/${DAYTONA_AGENT_IMAGE}`;
export const DAYTONA_AGENT_SNAPSHOT =
  `harness-agent-claude-${DAYTONA_AGENT_RELEASE}`;

export const CLAUDE_TOOLCHAIN_PREFLIGHT = [
  "set -eu",
  'node_version=$("/usr/local/bin/node" --version)',
  'npm_version=$("/usr/local/bin/npm" --version)',
  'npx_version=$("/usr/local/bin/npx" --version)',
  'claude_version=$("/usr/local/bin/claude" --version)',
  'printf "node=%s\\nnpm=%s\\nnpx=%s\\nclaude=%s\\n" ' +
    '"$node_version" "$npm_version" "$npx_version" "$claude_version"',
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
}

export function requireAgentSnapshot(environment: Environment): string {
  const snapshot = environment.HARNESS_DAYTONA_AGENT_SNAPSHOT?.trim();
  if (!snapshot) {
    throw new Error(
      "Missing required environment variable: " +
        "HARNESS_DAYTONA_AGENT_SNAPSHOT",
    );
  }
  return snapshot;
}

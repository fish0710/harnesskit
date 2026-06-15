export const NODE_VERSION = "22.14.0";
export const CLAUDE_CODE_VERSION = "2.1.145";
export const DAYTONA_AGENT_RELEASE = `${CLAUDE_CODE_VERSION}-r1`;
export const DAYTONA_AGENT_IMAGE =
  `harness-daytona-claude:${DAYTONA_AGENT_RELEASE}`;
export const DAYTONA_AGENT_REGISTRY_IMAGE =
  `registry:6000/harness/${DAYTONA_AGENT_IMAGE}`;
export const DAYTONA_AGENT_SNAPSHOT =
  `harness-agent-claude-${DAYTONA_AGENT_RELEASE}`;

type Environment = Record<string, string | undefined>;

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

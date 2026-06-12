import { pathToFileURL } from "node:url";

import {
  CLAUDE_COMMAND,
  CLAUDE_INSTALL_COMMAND,
  createDaytonaManager,
  getClaudeEnvironment,
} from "../src/harness/sandbox/daytona.js";

export async function runClaudeInDaytona(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const manager = createDaytonaManager({ environment });
  const sandbox = await manager.createAgentSandbox();

  try {
    const installation = await sandbox.execute(
      CLAUDE_INSTALL_COMMAND,
      "/workspace",
    );
    if (installation.exitCode !== 0) {
      throw new Error(
        `Failed to install Claude Code (exit ${installation.exitCode}): ` +
        `${installation.stderr || installation.stdout}`,
      );
    }

    const result = await sandbox.runPty(
      CLAUDE_COMMAND,
      "/workspace",
      {
        HARNESS_PROMPT: "write a dad joke about penguins",
        ...getClaudeEnvironment(environment),
      },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`Claude Code exited with code ${result.exitCode}`);
    }
  } finally {
    await sandbox.delete();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    await runClaudeInDaytona();
  } catch (error) {
    console.error("Failed to run Claude Code in Daytona sandbox:", error);
    process.exitCode = 1;
  }
}

import { pathToFileURL } from "node:url";

import { createDaytonaSdkProvider } from "../src/harness/sandbox/daytona.js";
import { requireAgentSnapshot } from "../src/harness/sandbox/toolchain.js";
import type { SandboxHandle } from "../src/harness/sandbox/types.js";

export async function runDaytonaPtyIntegration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (environment.RUN_DAYTONA_PTY_INTEGRATION !== "1") {
    console.log(
      "SKIP Daytona PTY integration: set RUN_DAYTONA_PTY_INTEGRATION=1",
    );
    return;
  }

  const agentSnapshot = requireAgentSnapshot(environment);
  const provider = createDaytonaSdkProvider(environment);
  let handle: SandboxHandle | undefined;
  try {
    handle = await provider.create({
      role: "agent",
      snapshot: agentSnapshot,
      envVars: {},
      ephemeral: true,
    });
    await handle.upload([], "/workspace");
    const result = await handle.runPty(
      "printf pty-ok",
      "/workspace",
      {},
      120_000,
    );
    if (result.exitCode !== 0 || !result.stdout.includes("pty-ok")) {
      throw new Error(
        `Expected PTY output to include pty-ok, got exit=${result.exitCode} ` +
          `stdout=${JSON.stringify(result.stdout)} ` +
          `stderr=${JSON.stringify(result.stderr)}`,
      );
    }
    console.log("PASS Daytona PTY integration");
  } finally {
    await handle?.delete();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    await runDaytonaPtyIntegration();
  } catch (error) {
    console.error(
      "Daytona PTY integration failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

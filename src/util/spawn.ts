import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string; // 进程根本没起来(如 ENOENT)
}

/** 跑一个子进程,捕获输出。'error' 事件 = 没起来 ⇒ spawnError(区别于非零退出)。 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal, env: opts.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: null, stdout, stderr, spawnError: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

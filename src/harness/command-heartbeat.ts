export const DEFAULT_COMMAND_HEARTBEAT_INTERVAL_MS = 30_000;

export interface CommandHeartbeatObservation {
  event: "agent.command.heartbeat";
  data: {
    id: string;
    attempt: number;
    kind: string;
    elapsedMs: number;
    claudeStreamPath?: string;
  };
}

export interface CommandHeartbeatOptions<T> {
  id: string;
  attempt: number;
  kind: string;
  streamPath?: string;
  intervalMs?: number;
  nowMs?: () => number;
  emit: (observation: CommandHeartbeatObservation) => void;
  run: () => Promise<T>;
}

export async function runWithCommandHeartbeat<T>(
  options: CommandHeartbeatOptions<T>,
): Promise<T> {
  const intervalMs = options.intervalMs ??
    DEFAULT_COMMAND_HEARTBEAT_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const runPromise = Promise.resolve().then(options.run);
  const timer = setInterval(() => {
    options.emit({
      event: "agent.command.heartbeat",
      data: {
        id: options.id,
        attempt: options.attempt,
        kind: options.kind,
        elapsedMs: Math.max(0, nowMs() - startedAtMs),
        ...(options.streamPath
          ? { claudeStreamPath: options.streamPath }
          : {}),
      },
    });
  }, intervalMs);
  timer.unref?.();
  try {
    return await runPromise;
  } finally {
    clearInterval(timer);
  }
}

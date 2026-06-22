export interface ClaudeStreamState {
  offset: number;
  pending: string;
  lastActivityAt?: string;
  lastEventType?: string;
  lastTool?: string;
}

export interface ClaudeStreamObservation {
  event: string;
  data: Record<string, unknown>;
}

export interface ClaudeStreamMeta {
  id: string;
  attempt: number;
  path: string;
  now?: () => string;
}

export interface TailClaudeStreamOptions<T> extends ClaudeStreamMeta {
  read(path: string): Promise<Buffer>;
  emit(observation: ClaudeStreamObservation): void;
  run(): Promise<T>;
  intervalMs?: number;
  noOutputWarningMs?: number;
}

type JsonObject = Record<string, unknown>;

const SUMMARY_LIMIT = 300;

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    offset: 0,
    pending: "",
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= SUMMARY_LIMIT
    ? normalized
    : `${normalized.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function summarizeToolInput(input: unknown): Record<string, string> {
  if (!isRecord(input)) return {};
  const summary: Record<string, string> = {};
  for (const key of ["command", "file_path", "path", "pattern"]) {
    const value = stringField(input, key);
    if (value) summary[key === "file_path" ? "path" : key] = summarizeText(value);
  }
  return summary;
}

function streamNow(meta: ClaudeStreamMeta): string {
  return meta.now ? meta.now() : new Date().toISOString();
}

function emitProgress(
  state: ClaudeStreamState,
  emit: (observation: ClaudeStreamObservation) => void,
  meta: ClaudeStreamMeta,
): void {
  const lastActivityAt = streamNow(meta);
  state.lastActivityAt = lastActivityAt;
  emit({
    event: "agent.command.progress",
    data: {
      id: meta.id,
      attempt: meta.attempt,
      path: meta.path,
      bytes: state.offset,
      ...(state.lastEventType ? { lastEventType: state.lastEventType } : {}),
      ...(state.lastTool ? { lastTool: state.lastTool } : {}),
      lastActivityAt,
    },
  });
}

function emitAssistantContent(
  record: JsonObject,
  state: ClaudeStreamState,
  emit: (observation: ClaudeStreamObservation) => void,
  meta: ClaudeStreamMeta,
): void {
  const message = record.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  for (const item of message.content) {
    if (!isRecord(item)) continue;
    const itemType = stringField(item, "type");
    if (itemType === "text") {
      const text = stringField(item, "text");
      if (!text) continue;
      emit({
        event: "agent.claude.text",
        data: {
          id: meta.id,
          attempt: meta.attempt,
          text: summarizeText(text),
        },
      });
    }
    if (itemType === "tool_use") {
      const tool = stringField(item, "name");
      if (!tool) continue;
      state.lastTool = tool;
      emit({
        event: "agent.claude.tool",
        data: {
          id: meta.id,
          attempt: meta.attempt,
          tool,
          ...summarizeToolInput(item.input),
        },
      });
    }
  }
}

function emitResult(
  record: JsonObject,
  emit: (observation: ClaudeStreamObservation) => void,
  meta: ClaudeStreamMeta,
): void {
  emit({
    event: "agent.claude.result",
    data: {
      id: meta.id,
      attempt: meta.attempt,
      ...(stringField(record, "session_id")
        ? { sessionId: stringField(record, "session_id") }
        : {}),
      ...(numberField(record, "duration_ms") !== undefined
        ? { durationMs: numberField(record, "duration_ms") }
        : {}),
      ...(numberField(record, "duration_api_ms") !== undefined
        ? { durationApiMs: numberField(record, "duration_api_ms") }
        : {}),
      ...(numberField(record, "ttft_ms") !== undefined
        ? { ttftMs: numberField(record, "ttft_ms") }
        : {}),
      ...(numberField(record, "num_turns") !== undefined
        ? { turns: numberField(record, "num_turns") }
        : {}),
    },
  });
}

export function consumeClaudeStreamChunk(
  input: string,
  state: ClaudeStreamState,
  emit: (observation: ClaudeStreamObservation) => void,
  meta: ClaudeStreamMeta,
): void {
  const combined = `${state.pending}${input}`;
  const lines = combined.split(/\n/);
  state.pending = lines.pop() ?? "";
  for (const line of lines) {
    const consumed = `${line}\n`;
    state.offset += Buffer.byteLength(consumed);
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const type = stringField(parsed, "type");
    if (type) state.lastEventType = type;
    if (type === "assistant") {
      emitAssistantContent(parsed, state, emit, meta);
    }
    emitProgress(state, emit, meta);
    if (type === "result") {
      emitResult(parsed, emit, meta);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollStream(
  options: TailClaudeStreamOptions<unknown>,
  state: ClaudeStreamState,
): Promise<boolean> {
  let content: Buffer;
  try {
    content = await options.read(options.path);
  } catch {
    return false;
  }
  const consumedAndPending = state.offset + Buffer.byteLength(state.pending);
  if (content.byteLength <= consumedAndPending) return false;
  const chunk = content.subarray(consumedAndPending).toString("utf8");
  const before = state.offset;
  consumeClaudeStreamChunk(chunk, state, options.emit, options);
  return state.offset > before;
}

export async function tailClaudeStreamDuring<T>(
  options: TailClaudeStreamOptions<T>,
): Promise<T> {
  const state = createClaudeStreamState();
  const intervalMs = options.intervalMs ?? 1000;
  const noOutputWarningMs = options.noOutputWarningMs ?? 60_000;
  let completed = false;
  let lastOutputMs = Date.now();
  let lastWarningMs = 0;
  const runPromise = options.run().finally(() => {
    completed = true;
  });
  // Mark the delayed await as handled; the rejection still propagates below.
  runPromise.catch(() => undefined);

  while (!completed) {
    const grew = await pollStream(options, state);
    if (grew) {
      lastOutputMs = Date.now();
    } else {
      const idleMs = Date.now() - lastOutputMs;
      if (
        idleMs >= noOutputWarningMs &&
        Date.now() - lastWarningMs >= noOutputWarningMs
      ) {
        lastWarningMs = Date.now();
        options.emit({
          event: "agent.command.no-output-warning",
          data: {
            id: options.id,
            attempt: options.attempt,
            path: options.path,
            bytes: state.offset,
            idleMs,
          },
        });
      }
    }
    if (!completed) await sleep(intervalMs);
  }

  try {
    return await runPromise;
  } finally {
    await pollStream(options, state);
  }
}

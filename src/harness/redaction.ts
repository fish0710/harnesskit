const SECRET_OBSERVATION_KEY =
  /(?:api[_-]?key|key|token|secret|password|authorization|auth|cookie)/i;

function isSecretObservationKey(key: string): boolean {
  return SECRET_OBSERVATION_KEY.test(key);
}

export function redactObservationData(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return "[unserializable]";
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactObservationData(item, seen));
  }

  const output: Record<string, unknown> = {};
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value);
  } catch {
    return "[unserializable]";
  }
  for (const [key, item] of entries) {
    output[key] = isSecretObservationKey(key)
      ? "[redacted]"
      : redactObservationData(item, seen);
  }
  return output;
}

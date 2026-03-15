import { createLogger } from "../core/logging.js";

const codecLogger = createLogger("db-codec");

function buildPreview(raw: string): string {
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

function logDecodeFailure(context: string, raw: string, error: unknown): void {
  codecLogger.warn("failed to decode persisted JSON", {
    context,
    raw: buildPreview(raw),
    error: error instanceof Error ? error.message : String(error),
  });
}

export function safeParseJson<T>(
  raw: string | null | undefined,
  context: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): T {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) {
      logDecodeFailure(context, raw, "validation failed");
      return fallback;
    }
    return (parsed as T) ?? fallback;
  } catch (error) {
    logDecodeFailure(context, raw, error);
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeParseJsonRecord(
  raw: string | null | undefined,
  context: string,
): Record<string, unknown> | null {
  return safeParseJson<Record<string, unknown> | null>(
    raw,
    context,
    null,
    (value): value is Record<string, unknown> => isRecord(value),
  );
}

export function safeParseJsonStringArray(
  raw: string | null | undefined,
  context: string,
): string[] {
  return safeParseJson<string[]>(
    raw,
    context,
    [],
    (value): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string"),
  );
}

export function safeStringifyJson(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    codecLogger.warn("failed to encode JSON", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

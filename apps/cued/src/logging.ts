import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CUED_DAEMON_LOG_PATH } from "./config.js";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

const DEFAULT_MAX_LOG_BYTES = Number(process.env.CUED_LOG_MAX_BYTES ?? 1_048_576);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLogDetails(details: unknown): string {
  if (details == null) {
    return "";
  }

  if (details instanceof Error) {
    return ` ${JSON.stringify({
      name: details.name,
      message: details.message,
      stack: details.stack,
    })}`;
  }

  if (typeof details === "string") {
    return ` ${JSON.stringify({ detail: details })}`;
  }

  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${JSON.stringify({ detail: String(details) })}`;
  }
}

function rotateLogFileIfNeeded(logPath = CUED_DAEMON_LOG_PATH): void {
  const maxLogBytes =
    Number.isFinite(DEFAULT_MAX_LOG_BYTES) && DEFAULT_MAX_LOG_BYTES > 0
      ? DEFAULT_MAX_LOG_BYTES
      : 1_048_576;

  if (!existsSync(logPath)) {
    return;
  }

  const stats = statSync(logPath);
  if (stats.size < maxLogBytes) {
    return;
  }

  try {
    renameSync(logPath, getRotatedLogPath(logPath));
  } catch {
    // Best effort rotation. If the rotated file exists already, fall through and keep appending.
  }
}

export function writeLogLine(
  level: LogLevel,
  subsystem: string,
  message: string,
  details?: unknown,
  logPath = CUED_DAEMON_LOG_PATH,
): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  rotateLogFileIfNeeded(logPath);
  const line = `${nowIso()} ${level.toUpperCase()} [${subsystem}] ${message}${normalizeLogDetails(details)}\n`;
  appendFileSync(logPath, line, "utf8");
}

export function createLogger(subsystem: string, logPath = CUED_DAEMON_LOG_PATH): Logger {
  return {
    info(message: string, details?: unknown) {
      writeLogLine("info", subsystem, message, details, logPath);
    },
    warn(message: string, details?: unknown) {
      writeLogLine("warn", subsystem, message, details, logPath);
    },
    error(message: string, details?: unknown) {
      writeLogLine("error", subsystem, message, details, logPath);
    },
  };
}

export function getRotatedLogPath(logPath = CUED_DAEMON_LOG_PATH): string {
  return `${logPath}.1`;
}

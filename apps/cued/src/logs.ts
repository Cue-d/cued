import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { watch } from "node:fs";
import { CUED_DAEMON_LOG_PATH } from "./config.js";

export interface LogsCommandOptions {
  follow: boolean;
  pathOnly: boolean;
  tail: number;
}

const DEFAULT_LOG_TAIL_LINES = 100;

export function getDaemonLogPath(): string {
  return CUED_DAEMON_LOG_PATH;
}

export function parseLogsCommandArgs(args: string[]): LogsCommandOptions {
  let follow = false;
  let pathOnly = false;
  let tail = DEFAULT_LOG_TAIL_LINES;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--follow":
        follow = true;
        break;
      case "--path":
        pathOnly = true;
        break;
      case "--tail":
      case "-n": {
        const value = args[index + 1];
        const parsed = Number(value);
        if (!value || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("Usage: cued logs [--tail <n>] [--follow] [--path]");
        }
        tail = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error("Usage: cued logs [--tail <n>] [--follow] [--path]");
    }
  }

  return { follow, pathOnly, tail };
}

export function readRecentLogLines(lineCount: number, logPath = CUED_DAEMON_LOG_PATH): string[] {
  if (!existsSync(logPath)) {
    return [];
  }

  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.slice(-lineCount);
}

function printLines(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function readRange(logPath: string, start: number, end: number): Promise<string> {
  if (end <= start) {
    return "";
  }

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(logPath, {
      encoding: "utf8",
      start,
      end: end - 1,
    });
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export async function followLogs(
  options: { tail: number; logPath?: string } = { tail: DEFAULT_LOG_TAIL_LINES },
): Promise<void> {
  const logPath = options.logPath ?? CUED_DAEMON_LOG_PATH;
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  printLines(readRecentLogLines(options.tail, logPath));

  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  let closed = false;

  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    watcher.close();
  };

  const readNewContent = async () => {
    if (!existsSync(logPath)) {
      offset = 0;
      return;
    }
    const stats = statSync(logPath);
    if (stats.size < offset) {
      offset = 0;
    }
    const chunk = await readRange(logPath, offset, stats.size);
    offset = stats.size;
    if (chunk.length > 0) {
      process.stdout.write(chunk);
    }
  };

  const watcher = watch(dirname(logPath), async (_eventType, fileName) => {
    if (closed || fileName !== "daemon.log") {
      return;
    }
    try {
      await readNewContent();
    } catch {
      // Keep follow mode alive on transient file rotation races.
    }
  });

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise<void>((resolve) => {
    watcher.on("close", () => resolve());
  });
}

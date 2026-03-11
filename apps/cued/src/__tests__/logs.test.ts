import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRotatedLogPath, writeLogLine } from "../logging.js";
import { parseLogsCommandArgs, readRecentLogLines } from "../logs.js";

describe("logs helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTempLogPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-logs-"));
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return join(dir, "daemon.log");
  }

  it("parses supported logs command options", () => {
    expect(parseLogsCommandArgs([])).toEqual({
      follow: false,
      pathOnly: false,
      tail: 100,
    });
    expect(parseLogsCommandArgs(["--tail", "25", "--follow"])).toEqual({
      follow: true,
      pathOnly: false,
      tail: 25,
    });
    expect(parseLogsCommandArgs(["--path"])).toEqual({
      follow: false,
      pathOnly: true,
      tail: 100,
    });
    expect(() => parseLogsCommandArgs(["--tail", "0"])).toThrow(
      "Usage: cued logs [--tail <n>] [--follow] [--path]",
    );
  });

  it("reads the most recent log lines", () => {
    const logPath = createTempLogPath();
    writeFileSync(logPath, "one\ntwo\nthree\nfour\n", "utf8");

    expect(readRecentLogLines(2, logPath)).toEqual(["three", "four"]);
  });

  it("rotates oversized daemon logs", () => {
    const logPath = createTempLogPath();
    writeFileSync(logPath, "x".repeat(1_048_600), "utf8");

    writeLogLine("info", "daemon", "hello world", undefined, logPath);

    const rotatedPath = getRotatedLogPath(logPath);
    expect(existsSync(rotatedPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("hello world");
  });
});

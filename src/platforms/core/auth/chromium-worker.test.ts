import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupStaleChromiumSingleton,
  SLACK_CONTINUE_IN_BROWSER_LABEL_PATTERN,
} from "./chromium-worker.js";

function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

describe("cleanupStaleChromiumSingleton", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createProfileDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-chromium-profile-"));
    tempDirs.push(dir);
    return dir;
  }

  it("removes Chromium singleton files when the owner process is gone", () => {
    const profileDir = createProfileDir();
    symlinkSync("openclaw-99999999", join(profileDir, "SingletonLock"));
    symlinkSync("socket", join(profileDir, "SingletonSocket"));
    symlinkSync("cookie", join(profileDir, "SingletonCookie"));

    cleanupStaleChromiumSingleton(profileDir);

    expect(fileExists(join(profileDir, "SingletonLock"))).toBe(false);
    expect(fileExists(join(profileDir, "SingletonSocket"))).toBe(false);
    expect(fileExists(join(profileDir, "SingletonCookie"))).toBe(false);
  });

  it("keeps Chromium singleton files when the owner process is still alive", () => {
    const profileDir = createProfileDir();
    symlinkSync(`openclaw-${process.pid}`, join(profileDir, "SingletonLock"));

    cleanupStaleChromiumSingleton(profileDir);

    expect(fileExists(join(profileDir, "SingletonLock"))).toBe(true);
  });
});

describe("SLACK_CONTINUE_IN_BROWSER_LABEL_PATTERN", () => {
  it("matches Slack redirect browser links", () => {
    expect(SLACK_CONTINUE_IN_BROWSER_LABEL_PATTERN.test("Continue in browser")).toBe(true);
    expect(SLACK_CONTINUE_IN_BROWSER_LABEL_PATTERN.test("use Slack in your browser")).toBe(true);
    expect(SLACK_CONTINUE_IN_BROWSER_LABEL_PATTERN.test("use Slack in browser")).toBe(true);
  });
});

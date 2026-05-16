import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  moveRuntimeDirectoryInsideRoot,
  removeRuntimeDirectoryInsideRoot,
} from "./runtime-paths.js";

describe("runtime path cleanup", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("removes a final symlink without deleting its target", () => {
    const root = createTempDir("cued-runtime-root-");
    const target = join(root, "other-account");
    const link = join(root, "account-link");
    const sentinel = join(target, "sentinel");
    mkdirSync(target, { recursive: true });
    writeFileSync(sentinel, "keep");
    symlinkSync(target, link, "dir");

    removeRuntimeDirectoryInsideRoot(link, root, "browser profile directory");

    expect(existsSync(link)).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("rejects cleanup through a symlinked ancestor", () => {
    const root = createTempDir("cued-runtime-root-");
    const target = join(root, "other-account");
    const link = join(root, "link");
    const nested = join(link, "profile");
    const sentinel = join(target, "profile", "sentinel");
    mkdirSync(join(target, "profile"), { recursive: true });
    writeFileSync(sentinel, "keep");
    symlinkSync(target, link, "dir");

    expect(() =>
      removeRuntimeDirectoryInsideRoot(nested, root, "browser profile directory"),
    ).toThrow("symlinked runtime path");
    expect(existsSync(sentinel)).toBe(true);
  });

  it("moves runtime directories using the original path, not the realpath target", () => {
    const root = createTempDir("cued-runtime-root-");
    const from = join(root, "pending");
    const to = join(root, "resolved");
    const sentinel = join(from, "sentinel");
    mkdirSync(from, { recursive: true });
    writeFileSync(sentinel, "keep");

    moveRuntimeDirectoryInsideRoot(from, to, root, "browser profile directory");

    expect(existsSync(from)).toBe(false);
    expect(existsSync(join(to, "sentinel"))).toBe(true);
  });
});

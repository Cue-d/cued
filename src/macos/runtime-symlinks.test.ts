import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneBundledRuntimeSymlinks } from "./runtime-symlinks.js";

describe("bundled runtime symlink pruning", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("keeps symlinks whose targets resolve inside the runtime root", () => {
    const runtimeRoot = createTempDir("cued-runtime-");
    const targetDir = join(
      runtimeRoot,
      "node_modules",
      ".pnpm",
      "better-sqlite3@1.0.0",
      "node_modules",
      "better-sqlite3",
    );
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "package.json"), "{}\n");

    const linkPath = join(runtimeRoot, "node_modules", "better-sqlite3");
    symlinkSync(".pnpm/better-sqlite3@1.0.0/node_modules/better-sqlite3", linkPath);

    const removed = pruneBundledRuntimeSymlinks(runtimeRoot);

    expect(removed).toEqual([]);
    expect(existsSync(linkPath)).toBe(true);
  });

  it("removes symlinks whose targets escape the runtime root", () => {
    const runtimeRoot = createTempDir("cued-runtime-");
    const outsideRoot = createTempDir("cued-outside-");
    const outsideTarget = join(outsideRoot, "apps", "cued");
    mkdirSync(outsideTarget, { recursive: true });
    writeFileSync(join(outsideTarget, "package.json"), "{}\n");

    const scopeDir = join(runtimeRoot, "node_modules", ".pnpm", "node_modules", "@cued");
    mkdirSync(scopeDir, { recursive: true });
    const linkPath = join(scopeDir, "app");
    symlinkSync(outsideTarget, linkPath);

    const removed = pruneBundledRuntimeSymlinks(runtimeRoot);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("/node_modules/.pnpm/node_modules/@cued/app");
    expect(existsSync(linkPath)).toBe(false);
  });

  it("removes symlinks whose targets no longer exist", () => {
    const runtimeRoot = createTempDir("cued-runtime-");
    const linkDir = join(runtimeRoot, "node_modules", ".pnpm", "node_modules");
    mkdirSync(linkDir, { recursive: true });
    const linkPath = join(linkDir, "acorn");
    symlinkSync("../acorn@8.15.0/node_modules/acorn", linkPath);

    const removed = pruneBundledRuntimeSymlinks(runtimeRoot);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("/node_modules/.pnpm/node_modules/acorn");
    expect(existsSync(linkPath)).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv.slice();
const tempDirs: string[] = [];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function importConfig(args = originalArgv) {
  process.argv.splice(0, process.argv.length, ...args);
  vi.resetModules();
  return import("./config.js");
}

describe("config path resolution", () => {
  it("uses configured home for runtime paths", async () => {
    const config = await importConfig();

    expect(config.resolveCuedHome({ home: "/tmp/cued-home" })).toBe("/tmp/cued-home");
    expect(config.resolveCuedDbPath({ home: "/tmp/cued-home" })).toBe("/tmp/cued-home/local.db");
  });

  it("derives the cued home from dbPath when only the db path is configured", async () => {
    const config = await importConfig();

    expect(config.resolveCuedHome({ dbPath: "/tmp/cued-db/local.db" })).toBe("/tmp/cued-db");
    expect(config.resolveCuedDbPath({ dbPath: "/tmp/cued-db/local.db" })).toBe(
      "/tmp/cued-db/local.db",
    );
  });

  it("uses an explicit missing config parent instead of the real home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-missing-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    const config = await importConfig(["node", "cued", "--config", configPath]);

    expect(config.resolveCuedHome()).toBe(dir);
    expect(config.resolveCuedDbPath()).toBe(join(dir, "local.db"));
  });

  it("uses an explicit malformed config parent instead of the real home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-malformed-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{", "utf8");
    const config = await importConfig(["node", "cued", "--config", configPath]);

    expect(config.resolveCuedHome()).toBe(dir);
    expect(config.resolveCuedDbPath()).toBe(join(dir, "local.db"));
  });

  it("strips runtime config args before command parsing", async () => {
    const config = await importConfig();

    expect(config.stripRuntimeConfigArgs(["--config", "/tmp/cued.json", "daemon"])).toEqual([
      "daemon",
    ]);
    expect(config.stripRuntimeConfigArgs(["--cued-config=/tmp/cued.json", "status"])).toEqual([
      "status",
    ]);
  });

  it("resolves packaged Chromium beside the bundled runtime", async () => {
    const config = await importConfig();
    const existingPaths = new Set([
      "/Applications/Cued.app/Contents/Resources/runtime/chromium/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ]);

    expect(
      config.resolveChromiumExecutablePath(
        "/Applications/Cued.app/Contents/Resources/cued-runtime",
        (path) => existingPaths.has(path),
      ),
    ).toBe(
      "/Applications/Cued.app/Contents/Resources/runtime/chromium/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
  });
});

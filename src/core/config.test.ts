import { describe, expect, it } from "vitest";

describe("config path resolution", () => {
  it("uses configured home for runtime paths", async () => {
    const config = await import("./config.js");

    expect(config.resolveCuedHome({ home: "/tmp/cued-home" })).toBe("/tmp/cued-home");
    expect(config.resolveCuedDbPath({ home: "/tmp/cued-home" })).toBe("/tmp/cued-home/local.db");
  });

  it("derives the cued home from dbPath when only the db path is configured", async () => {
    const config = await import("./config.js");

    expect(config.resolveCuedHome({ dbPath: "/tmp/cued-db/local.db" })).toBe("/tmp/cued-db");
    expect(config.resolveCuedDbPath({ dbPath: "/tmp/cued-db/local.db" })).toBe(
      "/tmp/cued-db/local.db",
    );
  });

  it("strips runtime config args before command parsing", async () => {
    const config = await import("./config.js");

    expect(config.stripRuntimeConfigArgs(["--config", "/tmp/cued.json", "daemon"])).toEqual([
      "daemon",
    ]);
    expect(config.stripRuntimeConfigArgs(["--cued-config=/tmp/cued.json", "status"])).toEqual([
      "status",
    ]);
  });

  it("resolves packaged Chromium beside the bundled runtime", async () => {
    const config = await import("./config.js");
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

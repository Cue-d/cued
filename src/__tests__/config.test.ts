import { afterEach, describe, expect, it, vi } from "vitest";

describe("config path resolution", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("uses CUED_HOME for all runtime paths", async () => {
    vi.stubEnv("CUED_HOME", "/tmp/cued-home");
    vi.stubEnv("CUED_DB_PATH", undefined);

    const config = await import("../config.js");

    expect(config.CUED_HOME).toBe("/tmp/cued-home");
    expect(config.CUED_DB_PATH).toBe("/tmp/cued-home/local.db");
    expect(config.CUED_SOCKET_PATH).toBe("/tmp/cued-home/cued.sock");
    expect(config.CUED_DAEMON_LOG_PATH).toBe("/tmp/cued-home/logs/daemon.log");
  });

  it("derives the cued home from CUED_DB_PATH when only the db path is overridden", async () => {
    vi.stubEnv("CUED_HOME", undefined);
    vi.stubEnv("CUED_DB_PATH", "/tmp/cued-db/local.db");

    const config = await import("../config.js");

    expect(config.CUED_HOME).toBe("/tmp/cued-db");
    expect(config.CUED_DB_PATH).toBe("/tmp/cued-db/local.db");
    expect(config.CUED_BROWSER_DIR).toBe("/tmp/cued-db/browser");
  });
});

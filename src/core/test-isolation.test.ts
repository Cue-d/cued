import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { removeIntegration } from "../platforms/core/state/mutations.js";
import { getSignalConfigDir } from "../platforms/signal/cli/binary.js";
import { getWhatsAppStoreDir } from "../platforms/whatsapp/helper/binary.js";
import { CUED_DAEMON_LOG_PATH, CUED_HOME } from "./config.js";
import { createLogger } from "./logging.js";

describe("test runtime isolation", () => {
  it("isolates imported paths, log writes and fallback integration deletion", () => {
    expect(CUED_HOME).toBe(process.env.CUED_HOME);
    expect(CUED_HOME).toContain("cued-test-home-");
    const db = new CuedDatabase(join(CUED_HOME, "isolation.db"));
    db.migrate();
    try {
      for (const platform of ["signal", "whatsapp"] as const) {
        const directory =
          platform === "signal" ? getSignalConfigDir("default") : getWhatsAppStoreDir("default");
        expect(directory.startsWith(`${CUED_HOME}/`)).toBe(true);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "sentinel"), "test data");
        db.upsertIntegrationState({
          platform,
          accountKey: "default",
          displayName: platform,
          authState: "authenticated",
          enabled: true,
          connectionKind: "local-cli",
          syncCapable: true,
          launchStrategy: "qr-native",
          launchTarget: null,
          importedFrom: "local-cli",
          metadata: {},
        });
        removeIntegration(db, platform, "default");
        expect(existsSync(directory)).toBe(false);
      }
      createLogger("test-isolation").info("isolated fixture log");
      expect(CUED_DAEMON_LOG_PATH.startsWith(`${CUED_HOME}/`)).toBe(true);
      expect(existsSync(CUED_DAEMON_LOG_PATH)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("preserves isolation after env unstubbing and passes it to children", () => {
    vi.stubEnv("CUED_HOME", "temporary-fixture-override");
    vi.unstubAllEnvs();
    expect(process.env.CUED_HOME).toBe(CUED_HOME);
    expect(process.env.CUED_DB_KEY).toBe("cued-isolated-test-key");
    expect(
      execFileSync(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify([process.env.CUED_HOME, process.env.CUED_DB_KEY]))",
        ],
        {
          encoding: "utf8",
        },
      ),
    ).toBe(JSON.stringify([CUED_HOME, "cued-isolated-test-key"]));
  });

  it("keeps OS-home fallbacks private when configured paths are cleared", async () => {
    vi.stubEnv("CUED_HOME", undefined);
    vi.stubEnv("CUED_DB_PATH", undefined);
    vi.resetModules();
    try {
      const fallback = await import("./config.js");
      expect(fallback.CUED_HOME).toBe(join(CUED_HOME, "user", ".cued"));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("blocks real Keychain access unless a test explicitly supplies its own fake", () => {
    const result = spawnSync("security", ["find-generic-password", "-s", "test-only"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(77);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

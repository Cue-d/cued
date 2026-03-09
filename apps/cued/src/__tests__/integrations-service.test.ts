import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import {
  completeAuthSession,
  getAuthSessionSummary,
  listIntegrationStates,
  listRequestableIntegrationPlatforms,
  markAuthSessionInProgress,
  refreshManagedIntegrationStates,
  requestIntegrationAccess,
  setIntegrationEnabled,
} from "../integrations/service.js";

describe("integration state management", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_DB_PATH;

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createDb(): CuedDatabase {
    const dir = createTempDir("cued-integrations-db-");
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("refreshes managed integrations and creates managed auth sessions for browser platforms", () => {
    const nativeBinaryDir = createTempDir("cued-native-binary-");
    const nativeBinaryPath = join(nativeBinaryDir, "CuedNative");
    writeFileSync(
      nativeBinaryPath,
      "#!/bin/sh\nif [ \"$1\" = \"contacts\" ] && [ \"$2\" = \"status\" ]; then\n  echo '{\"status\":\"authorized\"}'\n  exit 0\nfi\nexit 1\n",
    );
    chmodSync(nativeBinaryPath, 0o755);

    process.env.CUED_CONTACTS_NATIVE_BINARY = nativeBinaryPath;
    process.env.CUED_IMESSAGE_DB_PATH = join(createTempDir("cued-imessage-"), "missing.db");

    const db = createDb();
    const refreshed = refreshManagedIntegrationStates(db);
    expect(refreshed.refreshed).toBe(2);
    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          accountKey: "local",
          authState: "authorized",
        }),
        expect.objectContaining({
          platform: "imessage",
          accountKey: "local",
          authState: "missing",
        }),
      ]),
    );

    const requested = requestIntegrationAccess(db, "slack");
    expect(requested.integration.platform).toBe("slack");
    expect(requested.integration.authState).toBe("requested");
    expect(requested.integration.accountKey).toBe("default");
    expect(requested.integration.runtimeKind).toBe("chromium");
    expect(requested.integration.metadata).toEqual(
      expect.objectContaining({
        authManagedBy: "chromium-runtime",
      }),
    );
    expect(requested.authSession.state).toBe("requested");
    expect(requested.authSession.platform).toBe("slack");

    const running = markAuthSessionInProgress(db, requested.authSession.id, 12345);
    expect(running.state).toBe("in_progress");
    expect(getAuthSessionSummary(db, requested.authSession.id)?.nativePid).toBe(12345);

    const completed = completeAuthSession(db, requested.authSession.id, {
      state: "authenticated",
      keychainService: "dev.cued.auth.slack",
      keychainAccount: requested.integration.accountKey,
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(completed.integration.authState).toBe("authenticated");
    expect(completed.authSession.keychainService).toBe("dev.cued.auth.slack");

    const disabled = setIntegrationEnabled(db, "slack", requested.integration.accountKey, false);
    expect(disabled.enabled).toBe(false);
    expect(listRequestableIntegrationPlatforms()).toEqual([
      "slack",
      "linkedin",
      "whatsapp",
      "signal",
    ]);
    expect(() => requestIntegrationAccess(db, "gmail")).toThrow(
      "Unsupported integration platform: gmail",
    );
    expect(() => requestIntegrationAccess(db, "discord")).toThrow(
      "Unsupported integration request: discord",
    );
    db.close();
  });
});

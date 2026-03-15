import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { buildWhatsAppDiagnostics } from "./diagnostics.js";

describe("whatsapp diagnostics", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-whatsapp-diagnostics-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("falls back to persisted helper metadata for history diagnostics", () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "whatsapp",
      accountKey: "default",
      displayName: "WhatsApp",
      authState: "authenticated",
      enabled: true,
      connectionKind: "qr-link",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "bundled-helper",
      artifactPaths: ["/tmp/cued-whatsapp/default"],
      metadata: {
        whatsappAccountJid: "15551234567:18@s.whatsapp.net",
        whatsappLastHistorySyncAt: 100,
        whatsappLastHistorySyncType: "FULL",
        whatsappLastHistoryChunkOrder: 3,
        whatsappLastHistoryProgress: 75,
        whatsappQueuedHistorySyncCount: 2,
        whatsappLastHistorySyncError: "download failed",
        whatsappLastHistoryNotificationAt: 90,
      },
    });

    const diagnostics = buildWhatsAppDiagnostics(db);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        accountKey: "default",
        accountJid: "15551234567:18@s.whatsapp.net",
        lastHistorySyncAt: 100,
        lastHistorySyncType: "FULL",
        lastHistoryChunkOrder: 3,
        lastHistoryProgress: 75,
        queuedHistorySyncCount: 2,
        lastHistorySyncError: "download failed",
        lastHistoryNotificationAt: 90,
      }),
    ]);
    db.close();
  });
});

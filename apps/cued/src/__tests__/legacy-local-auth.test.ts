import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { importLegacyLocalAuth } from "../integrations/legacy-local-auth.js";

describe("legacy local auth import", () => {
  const tempDirs: string[] = [];
  const originalPath = process.env.PATH;

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    delete process.env.CUED_LEGACY_ELECTRON_USER_DATA_DIRS;
    delete process.env.CUED_LEGACY_ELECTRON_BINARY;
    delete process.env.CUED_LEGACY_ELECTRON_DECRYPT_SCRIPT;
    process.env.PATH = originalPath;

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("imports legacy Slack credentials into authenticated integration state", () => {
    const legacyDir = createTempDir("cued-legacy-electron-");
    const fakeEncryptedPath = join(legacyDir, "slack_credentials_T123.enc");
    writeFileSync(fakeEncryptedPath, "encrypted");

    const helperDir = createTempDir("cued-legacy-helper-");
    const decryptScript = join(helperDir, "decrypt.mjs");
    writeFileSync(
      decryptScript,
      [
        "process.stdout.write(JSON.stringify({",
        "token: 'xoxc-123',",
        "cookie: 'cookie-value',",
        "teamId: 'T123',",
        "teamName: 'Acme',",
        "userId: 'U123',",
        "savedAt: 1710000000000,",
        "}));",
      ].join(""),
    );
    const securityScript = join(helperDir, "security");
    writeFileSync(
      securityScript,
      "#!/bin/sh\nif [ \"$1\" = \"add-generic-password\" ]; then exit 0; fi\nif [ \"$1\" = \"find-generic-password\" ]; then echo '{\"ok\":true}'; exit 0; fi\nexit 1\n",
    );
    chmodSync(securityScript, 0o755);

    process.env.CUED_LEGACY_ELECTRON_USER_DATA_DIRS = legacyDir;
    process.env.CUED_LEGACY_ELECTRON_BINARY = process.execPath;
    process.env.CUED_LEGACY_ELECTRON_DECRYPT_SCRIPT = decryptScript;
    process.env.PATH = `${helperDir}:${process.env.PATH ?? ""}`;

    const dbDir = createTempDir("cued-db-");
    const db = new CuedDatabase(join(dbDir, "local.db"));
    db.migrate();

    const imported = importLegacyLocalAuth(db);
    expect(imported).toEqual([
      expect.objectContaining({
        platform: "slack",
        accountKey: "T123",
        imported: true,
      }),
    ]);

    const integration = db.getIntegrationState("slack", "T123");
    expect(integration?.auth_state).toBe("authenticated");
    expect(integration?.connection_kind).toBe("browser-session");
    expect(integration?.sync_capable).toBe(1);

    const latestSession = db.getLatestAuthSession("slack", "T123");
    expect(latestSession?.state).toBe("authenticated");
    expect(latestSession?.keychain_service).toBe("dev.cued.auth.slack");

    db.close();
  });
});

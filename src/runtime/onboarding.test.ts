import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding snapshot", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_DB_PATH;
    delete process.env.CUED_SLACK_APP_BINARY;
    delete process.env.CUED_APP_PATH;
    delete process.env.CUED_WHATSAPP_HELPER_BINARY;

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

  function createDb(): CuedDatabase {
    const dir = createTempDir("cued-onboarding-db-");
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function createPackagedSignalHelper(version = "0.12.9"): string {
    const appPath = join(createTempDir("cued-app-"), "Cued.app");
    const helperPath = join(
      appPath,
      "Contents",
      "Resources",
      "helpers",
      "signal-cli",
      "cued-signal-cli",
    );
    mkdirSync(join(helperPath, ".."), { recursive: true });
    writeFileSync(helperPath, `#!/bin/sh\necho "signal-cli ${version}"\n`);
    chmodSync(helperPath, 0o755);
    return appPath;
  }

  it("builds one snapshot with fresh permissions and onboarding integrations", async () => {
    const nativeBinaryDir = createTempDir("cued-native-binary-");
    const nativeBinaryPath = join(nativeBinaryDir, "CuedNative");
    writeFileSync(
      nativeBinaryPath,
      '#!/bin/sh\nif [ "$1" = "contacts" ] && [ "$2" = "status" ]; then\n  echo \'{"status":"authorized"}\'\n  exit 0\nfi\nexit 1\n',
    );
    chmodSync(nativeBinaryPath, 0o755);

    process.env.CUED_CONTACTS_NATIVE_BINARY = nativeBinaryPath;
    process.env.CUED_IMESSAGE_DB_PATH = join(createTempDir("cued-imessage-"), "missing.db");
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");
    process.env.CUED_APP_PATH = createPackagedSignalHelper();
    process.env.CUED_WHATSAPP_HELPER_BINARY = join(
      createTempDir("cued-no-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );

    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db, { refreshManagedIntegrations: true });

    expect(snapshot.permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
      "diagnostics",
    ]);
    expect(snapshot.globalSkill).toEqual(
      expect.objectContaining({
        installed: expect.any(Boolean),
        status: expect.any(String),
      }),
    );
    expect(snapshot.permissions.find((permission) => permission.key === "contacts")).toEqual(
      expect.objectContaining({
        status: process.platform === "darwin" ? "granted" : "unknown",
      }),
    );
    expect(snapshot.permissions.find((permission) => permission.key === "diagnostics")).toEqual(
      expect.objectContaining({
        status: "disabled",
        summary: "Redacted diagnostic reporting is disabled",
      }),
    );
    expect(snapshot.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          accountKey: "local",
          authState: "authorized",
        }),
        expect.objectContaining({
          platform: "signal",
          accountKey: "default",
          authState: "outdated",
        }),
        expect.objectContaining({
          platform: "whatsapp",
          accountKey: "default",
          authState: "blocked",
        }),
      ]),
    );
    expect(snapshot.setupIntegrations.map((integration) => integration.platform)).toEqual([
      "contacts",
      "imessage",
      "slack",
      "discord",
      "gmail",
      "linkedin",
      "whatsapp",
      "signal",
    ]);

    db.close();
  });

  it("ignores unsupported persisted integrations when building the snapshot", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "telegram" as never,
      accountKey: "default",
      displayName: "Telegram",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://web.telegram.org",
      importedFrom: "local-cli",
    });

    const snapshot = await buildOnboardingSnapshot(db);

    expect(
      snapshot.integrations.some((integration) => String(integration.platform) === "telegram"),
    ).toBe(false);
    expect(snapshot.setupIntegrations.map((integration) => integration.platform)).toEqual([
      "contacts",
      "imessage",
      "slack",
      "discord",
      "gmail",
      "linkedin",
      "whatsapp",
      "signal",
    ]);

    db.close();
  });

  it("keeps the Signal setup row connectable before helper diagnostics are refreshed", async () => {
    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db, { refreshManagedIntegrations: false });
    const signal = snapshot.setupIntegrations.find(
      (integration) => integration.platform === "signal",
    );

    expect(signal).toEqual(
      expect.objectContaining({
        accountKey: "default",
        authState: "missing",
        capability: expect.objectContaining({
          availability: "available",
          onboardingVisible: true,
        }),
      }),
    );

    db.close();
  });

  it("includes a relationship summary for the onboarding application page", async () => {
    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db);

    expect(snapshot.relationshipSummary).toEqual({
      messages: 0,
      contacts: 0,
      phoneCalls: 0,
      pendingProjectionEvents: 0,
      lastUpdatedAt: null,
      source: "database",
    });

    db.close();
  });

  it("does not load raw schema diagnostics for onboarding", async () => {
    const db = createDb();
    const projectionStats = vi.spyOn(db, "getIntegrationProjectionStats");

    await buildOnboardingSnapshot(db);

    expect(projectionStats).not.toHaveBeenCalled();

    db.close();
  });

  it("builds platform breakdowns directly when the menu bar cache is unavailable", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "imessage",
      accountKey: "local",
      displayName: "Messages",
      authState: "authorized",
      enabled: true,
      connectionKind: "native",
      syncCapable: false,
      launchStrategy: "system-settings",
      launchTarget: null,
      importedFrom: "test",
    });
    const sqlite = (
      db as unknown as {
        sqlite: { exec: (sql: string) => void };
      }
    ).sqlite;
    sqlite.exec(`
      INSERT INTO contacts (id, kind, name, archived, created_at, updated_at)
      VALUES ('contact-1', 'person', 'Ava', 0, 1, 1);
      INSERT INTO contact_sources (
        id, contact_id, platform, account_key, source_entity_key, first_seen_at, last_seen_at
      ) VALUES ('source-1', 'contact-1', 'imessage', 'local', 'ava', 1, 1);
      INSERT INTO conversations (
        id, platform, account_key, source_conversation_key, type, is_active,
        unread_count, created_at, updated_at
      ) VALUES ('conversation-1', 'imessage', 'local', 'chat-1', 'dm', 1, 0, 1, 1);
      INSERT INTO messages (
        id, platform, account_key, platform_message_id, conversation_id, sent_at,
        is_from_me, is_deleted, is_edited, attachment_count, reaction_count, created_at, updated_at
      ) VALUES (
        'message-1', 'imessage', 'local', 'message-1', 'conversation-1', 1,
        0, 0, 0, 0, 0, 1, 1
      );
    `);

    const snapshot = await buildOnboardingSnapshot(db);
    const imessage = snapshot.integrations.find(
      (integration) => integration.platform === "imessage" && integration.accountKey === "local",
    );

    expect(imessage?.projectionStats).toEqual(
      expect.objectContaining({
        projectedContacts: 1,
        projectedMessages: 1,
      }),
    );

    db.close();
  });
});

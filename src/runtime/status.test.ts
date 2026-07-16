import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { buildMenuBarDaemonStatusSnapshot } from "./status.js";

describe("menu bar status snapshot", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("includes cached message and contact counts for each integration", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-menu-status-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
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
    const realtime = { getStatuses: () => [] };

    const snapshot = buildMenuBarDaemonStatusSnapshot(db, {
      app: {},
      discordRealtime: realtime as never,
      slackRealtime: realtime as never,
      linkedInRealtime: realtime as never,
      signalRealtime: realtime as never,
      whatsAppRealtime: realtime as never,
      socketPath: join(dir, "daemon.sock"),
      bootstrap: {
        state: "ready",
        startedAt: 1,
        finishedAt: 2,
        error: null,
      },
    });

    expect(
      snapshot.integrations.find(
        (integration) => integration.platform === "imessage" && integration.accountKey === "local",
      )?.projectionStats,
    ).toEqual(
      expect.objectContaining({
        projectedContacts: 1,
        projectedMessages: 1,
        rawEventsBySchema: {},
      }),
    );

    db.close();
  });
});

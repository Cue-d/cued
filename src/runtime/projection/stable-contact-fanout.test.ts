import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents } from "./projector.js";

it("does not reindex conversation history for stable contact metadata but propagates real renames", () => {
  const dir = mkdtempSync(join(tmpdir(), "cued-contact-fanout-"));
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    let sequence = 0;
    const observe = (displayName: string, company: string) => {
      sequence += 1;
      db.insertRawEvent({
        id: `contact-${sequence}`,
        platform: "slack",
        accountKey: "workspace",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: sequence,
        dedupeKey: `contact-${sequence}`,
        sourceVersion: "test",
        payload: {
          sourceEntityKey: "person",
          fields: { display_name: displayName, company },
          handles: [],
        },
      });
    };
    observe("Ava Chen", "Before");
    for (let channel = 0; channel < 2; channel++) {
      db.insertRawEvent({
        id: `channel-${channel}`,
        platform: "slack",
        accountKey: "workspace",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 2,
        dedupeKey: `channel-${channel}`,
        sourceVersion: "test",
        payload: {
          sourceConversationKey: `channel-${channel}`,
          conversationType: "group",
          displayName: `Channel ${channel}`,
          participants: [{ sourceEntityKey: "person" }],
        },
      });
      for (let i = 0; i < 50; i++) {
        db.insertRawEvent({
          id: `message-${channel}-${i}`,
          platform: "slack",
          accountKey: "workspace",
          entityKind: "message",
          eventKind: "created",
          observedAt: 3,
          dedupeKey: `message-${channel}-${i}`,
          sourceVersion: "test",
          payload: {
            sourceMessageKey: `message-${channel}-${i}`,
            sourceConversationKey: `channel-${channel}`,
            senderSourceKey: "person",
            sentAt: 3,
            content: "hello",
            isFromMe: false,
          },
        });
      }
    }
    projectPendingRawEvents(db);
    while (db.drainMessageFtsIndexQueue(1000).claimed > 0) {}
    expect(db.getMessageFtsIndexBacklog().pending).toBe(0);
    for (let i = 0; i < 3; i++) {
      observe("Ava Chen", "After");
      projectPendingRawEvents(db);
      expect(db.getMessageFtsIndexBacklog().pending).toBe(0);
    }
    expect(db.orm().get<{ company: string }>(sql`SELECT company FROM contacts`)).toEqual({
      company: "After",
    });
    observe("Ava Renamed", "After");
    projectPendingRawEvents(db);
    expect(db.getMessageFtsIndexBacklog().pending).toBe(100);
    expect(
      db.orm().all<{ sender_name: string }>(sql`SELECT DISTINCT sender_name FROM messages`),
    ).toEqual([{ sender_name: "Ava Renamed" }]);
    expect(
      db
        .orm()
        .all<{ participant_name: string }>(
          sql`SELECT DISTINCT participant_name FROM conversation_participants`,
        ),
    ).toEqual([{ participant_name: "Ava Renamed" }]);
    while (db.drainMessageFtsIndexQueue(1000).claimed > 0) {}
    expect(
      db
        .orm()
        .get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'Renamed'`,
        )?.count,
    ).toBe(100);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { rebuildProjectedState } from "../projector/projector.js";

describe("projector", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-projector-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("rebuilds projected state and preserves agent-facing views", () => {
    const db = createDb();

    db.insertRawEvent({
      id: randomUUID(),
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1_710_000_000_000,
      dedupeKey: "contacts:ava",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: {
          display_name: "Ava Chen",
          photo_url: "https://example.com/ava.png",
          company: "Cued",
        },
        handles: [
          { type: "email", value: "ava@cued.com", deterministic: true },
          { type: "phone", value: "+1 (555) 123-4567", deterministic: true },
        ],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: randomUUID(),
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 1_710_000_000_100,
      dedupeKey: "linkedin:thread-1",
      payload: {
        sourceConversationKey: "thread-1",
        conversationType: "dm",
        participants: [{ sourceEntityKey: "contacts:ava" }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: randomUUID(),
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 1_710_000_000_200,
      dedupeKey: "linkedin:msg-1",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "thread-1",
        senderSourceKey: "contacts:ava",
        sentAt: 1_710_000_000_150,
        contentOriginal: "Founder update tomorrow?",
        statusDelivery: "delivered",
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: randomUUID(),
      platform: "linkedin",
      accountKey: "default",
      entityKind: "reaction",
      eventKind: "created",
      observedAt: 1_710_000_000_300,
      dedupeKey: "linkedin:msg-1:thumbs-up",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "thread-1",
        reactorSourceKey: "contacts:ava",
        emoji: "👍",
        timestamp: 1_710_000_000_250,
        isActive: true,
      },
      sourceVersion: "linkedin-v1",
    });

    expect(rebuildProjectedState(db)).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 4,
    });

    const ftsRows = db.orm().all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
    expect(ftsRows[0]?.count).toBe(1);

    const contactsDirectory = db.orm().all<{
      preferred_display_name: string;
      handles: string;
      source_platforms: string;
    }>(sql`
      SELECT preferred_display_name, handles, source_platforms
      FROM contact_directory
    `);
    expect(contactsDirectory).toEqual([
      expect.objectContaining({
        preferred_display_name: "Ava Chen",
        handles: expect.stringContaining("ava@cued.com"),
        source_platforms: "contacts",
      }),
    ]);

    const searchResults = db.orm().all<{
      conversation_name: string;
      sender_name: string;
      content_current: string;
    }>(sql`
      SELECT conversation_name, sender_name, content_current
      FROM message_search_results
    `);
    expect(searchResults).toEqual([
      {
        conversation_name: "Ava Chen",
        sender_name: "Ava Chen",
        content_current: "Founder update tomorrow?",
      },
    ]);

    const reactionRows = db.orm().all<{ reaction_count: number }>(sql`
      SELECT reaction_count
      FROM messages
    `);
    expect(reactionRows).toEqual([{ reaction_count: 1 }]);

    db.close();
  });

  it("rebuilds out-of-order Slack-style events without foreign key failures", () => {
    const db = createDb();
    const observedAt = 1_710_100_000_000;

    db.insertRawEvent({
      id: "conversation-before-contact",
      platform: "slack",
      accountKey: "T0A9C9RHZ9T",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt,
      dedupeKey: "slack:conversation:C123",
      payload: {
        sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
        conversationType: "dm",
        participants: [{ sourceEntityKey: "slack:T0A9C9RHZ9T:U123" }],
      },
      sourceVersion: "slack-v1",
    });
    db.insertRawEvent({
      id: "message-before-contact",
      platform: "slack",
      accountKey: "T0A9C9RHZ9T",
      entityKind: "message",
      eventKind: "message_created",
      observedAt,
      dedupeKey: "slack:message:C123:1",
      payload: {
        sourceMessageKey: "slack:T0A9C9RHZ9T:C123:1710100000.000100",
        sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
        senderSourceKey: "slack:T0A9C9RHZ9T:U123",
        sentAt: observedAt - 500,
        contentOriginal: "hello from slack",
      },
      sourceVersion: "slack-v1",
    });
    db.insertRawEvent({
      id: "reaction-before-contact",
      platform: "slack",
      accountKey: "T0A9C9RHZ9T",
      entityKind: "reaction",
      eventKind: "reaction_added",
      observedAt,
      dedupeKey: "slack:reaction:C123:1:thumbsup",
      payload: {
        sourceMessageKey: "slack:T0A9C9RHZ9T:C123:1710100000.000100",
        sourceConversationKey: "slack:T0A9C9RHZ9T:C123",
        reactorSourceKey: "slack:T0A9C9RHZ9T:U123",
        emoji: ":thumbsup:",
        timestamp: observedAt - 400,
        isActive: true,
      },
      sourceVersion: "slack-v1",
    });
    db.insertRawEvent({
      id: "contact-after",
      platform: "slack",
      accountKey: "T0A9C9RHZ9T",
      entityKind: "contact",
      eventKind: "observed",
      observedAt,
      dedupeKey: "slack:contact:U123",
      payload: {
        sourceEntityKey: "slack:T0A9C9RHZ9T:U123",
        fields: {
          display_name: "Theo Tarr",
        },
        handles: [
          { type: "slack_user_id", value: "T0A9C9RHZ9T:U123", deterministic: true },
        ],
      },
      sourceVersion: "slack-v1",
    });

    expect(rebuildProjectedState(db)).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 4,
    });

    const participantRows = db.orm().all<{ participant_name: string | null }>(sql`
      SELECT c.preferred_display_name as participant_name
      FROM conversation_participants cp
      JOIN contacts c ON c.id = cp.contact_id
    `);
    expect(participantRows).toEqual([{ participant_name: "Theo Tarr" }]);

    const messageRows = db.orm().all<{ sender_name: string | null; reaction_count: number }>(sql`
      SELECT sender.preferred_display_name as sender_name, m.reaction_count
      FROM messages m
      LEFT JOIN contacts sender ON sender.id = m.sender_contact_id
    `);
    expect(messageRows).toEqual([{ sender_name: "Theo Tarr", reaction_count: 1 }]);

    db.close();
  });
});

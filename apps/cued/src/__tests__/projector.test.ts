import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import {
  projectDeferredRange,
  projectPendingRawEvents,
  projectRealtimeRange,
  rebuildProjectedState,
} from "../projector/projector.js";

describe("projector", () => {
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
        service: "linkedin",
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
        content: "Founder update tomorrow?",
        service: "linkedin",
        status: "delivered",
        isFromMe: false,
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
      appliedRawEvents: 4,
      projectionWatermark: 4,
    });

    const ftsRows = db
      .orm()
      .all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
    expect(ftsRows[0]?.count).toBe(1);

    const contactRows = db.orm().all<{
      name: string | null;
      handle_count: number;
      source_count: number;
    }>(sql`
      SELECT
        c.name,
        (SELECT COUNT(*) FROM contact_handles h WHERE h.contact_id = c.id) AS handle_count,
        (SELECT COUNT(*) FROM contact_sources s WHERE s.contact_id = c.id) AS source_count
      FROM contacts c
    `);
    expect(contactRows).toEqual([
      expect.objectContaining({
        name: "Ava Chen",
        handle_count: 2,
        source_count: 1,
      }),
    ]);

    const searchResults = db.orm().all<{
      conversation_name: string;
      sender_name: string;
      content: string;
    }>(sql`
      SELECT m.conversation_name, m.sender_name, m.content
      FROM messages_fts f
      JOIN messages m ON m.id = f.message_id
    `);
    expect(searchResults).toEqual([
      {
        conversation_name: "Ava Chen",
        sender_name: "Ava Chen",
        content: "Founder update tomorrow?",
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
        service: "slack",
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
        content: "hello from slack",
        service: "slack",
        isFromMe: false,
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
        handles: [{ type: "slack_user_id", value: "T0A9C9RHZ9T:U123", deterministic: true }],
      },
      sourceVersion: "slack-v1",
    });

    expect(rebuildProjectedState(db)).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 4,
      appliedRawEvents: 4,
      projectionWatermark: 4,
    });

    const participantRows = db.orm().all<{ participant_name: string | null }>(sql`
      SELECT participant_name
      FROM conversation_participants
    `);
    expect(participantRows).toEqual([{ participant_name: "Theo Tarr" }]);

    const messageRows = db.orm().all<{ sender_name: string | null; reaction_count: number }>(sql`
      SELECT sender_name, reaction_count
      FROM messages
    `);
    expect(messageRows).toEqual([{ sender_name: "Theo Tarr", reaction_count: 1 }]);

    db.close();
  });

  it("projects new raw events incrementally without clearing canonical tables", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contacts-ava",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 10,
      dedupeKey: "contacts:ava",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "email", value: "ava@cued.com", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });

    expect(projectPendingRawEvents(db)).toEqual({
      contacts: 1,
      conversations: 0,
      messages: 0,
      rawEvents: 1,
      appliedRawEvents: 1,
      projectionWatermark: 1,
    });

    db.insertRawEvent({
      id: "conversation-1",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 20,
      dedupeKey: "linkedin:thread-1",
      payload: {
        sourceConversationKey: "thread-1",
        conversationType: "dm",
        service: "linkedin",
        participants: [{ sourceEntityKey: "contacts:ava" }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "message-1",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 30,
      dedupeKey: "linkedin:msg-1",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "thread-1",
        senderSourceKey: "contacts:ava",
        sentAt: 25,
        content: "incremental projection",
        service: "linkedin",
        isFromMe: false,
      },
      sourceVersion: "linkedin-v1",
    });

    expect(projectPendingRawEvents(db)).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 3,
      appliedRawEvents: 2,
      projectionWatermark: 3,
    });

    expect(projectPendingRawEvents(db)).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 3,
      appliedRawEvents: 0,
      projectionWatermark: 3,
    });

    const rows = db.orm().all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages`);
    expect(rows).toEqual([{ count: 1 }]);

    db.close();
  });

  it("supports batch-limited incremental projection", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contact-1",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:one",
      payload: {
        sourceEntityKey: "contacts:one",
        fields: { display_name: "One" },
        handles: [{ type: "email", value: "one@example.com", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "contact-2",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "contacts:two",
      payload: {
        sourceEntityKey: "contacts:two",
        fields: { display_name: "Two" },
        handles: [{ type: "email", value: "two@example.com", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });

    expect(projectPendingRawEvents(db, { limit: 1 })).toEqual({
      contacts: 1,
      conversations: 0,
      messages: 0,
      rawEvents: 2,
      appliedRawEvents: 1,
      projectionWatermark: 1,
    });

    expect(projectPendingRawEvents(db, { limit: 1 })).toEqual({
      contacts: 2,
      conversations: 0,
      messages: 0,
      rawEvents: 2,
      appliedRawEvents: 1,
      projectionWatermark: 2,
    });

    db.close();
  });

  it("keeps inbox state hot before deferred projection finishes", () => {
    const db = createDb();

    const insertResult = db.insertRawEvents([
      {
        id: "contact-hot-path",
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "contact-hot-path",
        payload: {
          sourceEntityKey: "contacts:ava",
          fields: { display_name: "Ava Chen" },
          handles: [{ type: "email", value: "ava@example.com", deterministic: true }],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "conversation-hot-path",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 2,
        dedupeKey: "conversation-hot-path",
        payload: {
          sourceConversationKey: "thread-hot-path",
          conversationType: "dm",
          participants: [{ sourceEntityKey: "contacts:ava" }],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "message-hot-path",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "message_created",
        observedAt: 3,
        dedupeKey: "message-hot-path",
        payload: {
          sourceMessageKey: "message-hot-path",
          sourceConversationKey: "thread-hot-path",
          senderSourceKey: "contacts:ava",
          sentAt: 3,
          content: "hot path preview",
          isFromMe: false,
        },
        sourceVersion: "test-v1",
      },
    ]);

    projectRealtimeRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
      batchSize: 10,
    });

    const hotConversation = db.orm().get<{
      last_message_preview: string | null;
      unread_count: number;
      participant_names: string | null;
    }>(sql`
      SELECT last_message_preview, unread_count, participant_names
      FROM conversations
      WHERE source_conversation_key = 'thread-hot-path'
    `);
    expect(hotConversation).toEqual({
      last_message_preview: "hot path preview",
      unread_count: 1,
      participant_names: null,
    });

    const hotMessage = db.orm().get<{
      content: string | null;
      sender_name: string | null;
    }>(sql`
      SELECT content, sender_name
      FROM messages
      WHERE platform_message_id = 'message-hot-path'
    `);
    expect(hotMessage).toEqual({
      content: "hot path preview",
      sender_name: null,
    });

    const hotFtsRows = db
      .orm()
      .all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
    expect(hotFtsRows).toEqual([{ count: 0 }]);

    projectDeferredRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
    });

    const coldConversation = db.orm().get<{
      name: string | null;
      participant_names: string | null;
    }>(sql`
      SELECT name, participant_names
      FROM conversations
      WHERE source_conversation_key = 'thread-hot-path'
    `);
    expect(coldConversation).toEqual({
      name: "Ava Chen",
      participant_names: "Ava Chen",
    });

    const coldMessage = db.orm().get<{
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT sender_name, conversation_name
      FROM messages
      WHERE platform_message_id = 'message-hot-path'
    `);
    expect(coldMessage).toEqual({
      sender_name: "Ava Chen",
      conversation_name: "Ava Chen",
    });

    const coldFtsRows = db
      .orm()
      .all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
    expect(coldFtsRows).toEqual([{ count: 1 }]);

    db.close();
  });

  it("replays older contacts observations onto existing imessage stubs without rewinding the watermark", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contacts-ava-phone",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:ava-phone",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "phone", value: "+1 (555) 123-4567", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "imessage-conversation-ava",
      platform: "imessage",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "imessage:conversation:ava",
      payload: {
        sourceConversationKey: "chat-ava",
        conversationType: "dm",
        service: "iMessage",
        displayName: "+15551234567",
        participants: [{ sourceEntityKey: "imessage:+15551234567" }],
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "imessage-message-ava",
      platform: "imessage",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 3,
      dedupeKey: "imessage:message:ava",
      payload: {
        sourceMessageKey: "message-ava",
        sourceConversationKey: "chat-ava",
        senderSourceKey: "imessage:+15551234567",
        sentAt: 3,
        content: "hello from imessage",
        service: "iMessage",
        isFromMe: false,
      },
      sourceVersion: "imessage-v1",
    });

    expect(
      projectDeferredRange(db, {
        startRowId: 2,
        endRowId: 3,
      }),
    ).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 3,
      appliedRawEvents: 2,
      projectionWatermark: 3,
      completed: true,
      nextStartRowId: null,
      rangeStartRowId: 2,
      rangeEndRowId: 3,
    });

    const beforeReplay = db.orm().get<{
      name: string | null;
      participant_names: string | null;
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT
        c.name,
        conv.participant_names,
        msg.sender_name,
        msg.conversation_name
      FROM contacts c
      JOIN conversation_participants cp ON cp.contact_id = c.id
      JOIN conversations conv ON conv.id = cp.conversation_id
      JOIN messages msg ON msg.sender_contact_id = c.id
      WHERE cp.source_participant_key = 'imessage:+15551234567'
    `);
    expect(beforeReplay).toEqual({
      name: null,
      participant_names: null,
      sender_name: null,
      conversation_name: "+15551234567",
    });

    expect(
      projectDeferredRange(db, {
        startRowId: 1,
        endRowId: 1,
      }),
    ).toEqual({
      contacts: 1,
      conversations: 1,
      messages: 1,
      rawEvents: 3,
      appliedRawEvents: 1,
      projectionWatermark: 3,
      completed: true,
      nextStartRowId: null,
      rangeStartRowId: 1,
      rangeEndRowId: 1,
    });

    const afterReplay = db.orm().get<{
      name: string | null;
      participant_names: string | null;
      sender_name: string | null;
      conversation_name: string | null;
      handle_count: number;
      source_count: number;
      contact_count: number;
    }>(sql`
      SELECT
        c.name,
        conv.participant_names,
        msg.sender_name,
        msg.conversation_name,
        (SELECT COUNT(*) FROM contact_handles h WHERE h.contact_id = c.id) AS handle_count,
        (SELECT COUNT(*) FROM contact_sources s WHERE s.contact_id = c.id) AS source_count,
        (SELECT COUNT(*) FROM contacts) AS contact_count
      FROM contacts c
      JOIN conversation_participants cp ON cp.contact_id = c.id
      JOIN conversations conv ON conv.id = cp.conversation_id
      JOIN messages msg ON msg.sender_contact_id = c.id
      WHERE cp.source_participant_key = 'imessage:+15551234567'
    `);
    expect(afterReplay).toEqual({
      name: "Ava Chen",
      participant_names: "Ava Chen",
      sender_name: "Ava Chen",
      conversation_name: "Ava Chen",
      handle_count: 1,
      source_count: 1,
      contact_count: 1,
    });

    db.close();
  });

  it("resolves replies, projects attachments, and propagates renamed names", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contact-ava",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:ava",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "email", value: "ava@cued.com", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "conversation-ava",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "linkedin:thread-ava",
      payload: {
        sourceConversationKey: "thread-ava",
        conversationType: "dm",
        service: "linkedin",
        participants: [{ sourceEntityKey: "contacts:ava" }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "reply-message",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 3,
      dedupeKey: "linkedin:reply",
      payload: {
        sourceMessageKey: "reply",
        sourceConversationKey: "thread-ava",
        senderSourceKey: "contacts:ava",
        sentAt: 30,
        content: "reply first",
        service: "linkedin",
        isFromMe: false,
        replyToSourceMessageKey: "parent",
        attachments: [
          {
            id: "att-1",
            kind: "file",
            name: "agenda.pdf",
            title: "Agenda",
            text: "Board agenda",
          },
        ],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "parent-message",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 4,
      dedupeKey: "linkedin:parent",
      payload: {
        sourceMessageKey: "parent",
        sourceConversationKey: "thread-ava",
        senderSourceKey: "contacts:ava",
        sentAt: 20,
        content: "parent later",
        service: "linkedin",
        isFromMe: false,
      },
      sourceVersion: "linkedin-v1",
    });

    rebuildProjectedState(db);

    const replyRows = db.orm().all<{
      platform_message_id: string;
      reply_to_message_id: string | null;
      attachment_count: number;
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT platform_message_id, reply_to_message_id, attachment_count, sender_name, conversation_name
      FROM messages
      ORDER BY sent_at ASC
    `);
    const parent = replyRows.find((row) => row.platform_message_id === "parent");
    const reply = replyRows.find((row) => row.platform_message_id === "reply");
    const parentIdRow = db.orm().get<{ id: string }>(sql`
      SELECT id
      FROM messages
      WHERE platform_message_id = 'parent'
    `);
    expect(parent?.reply_to_message_id).toBeNull();
    expect(reply?.reply_to_message_id).toBe(parentIdRow?.id ?? null);
    expect(reply?.attachment_count).toBe(1);
    expect(reply?.sender_name).toBe("Ava Chen");
    expect(reply?.conversation_name).toBe("Ava Chen");

    const attachmentRows = db.orm().all<{ filename: string | null; title: string | null }>(sql`
      SELECT filename, title
      FROM message_attachments
    `);
    expect(attachmentRows).toEqual([{ filename: "agenda.pdf", title: "Agenda" }]);

    db.insertRawEvent({
      id: "contact-ava-rename",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 5,
      dedupeKey: "contacts:ava:rename",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Zhang" },
        handles: [{ type: "email", value: "ava@cued.com", deterministic: true }],
      },
      sourceVersion: "contacts-v2",
    });
    db.insertRawEvent({
      id: "conversation-ava-rename",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 6,
      dedupeKey: "linkedin:thread-ava:rename",
      payload: {
        sourceConversationKey: "thread-ava",
        conversationType: "dm",
        displayName: "Investor thread",
        participants: [{ sourceEntityKey: "contacts:ava" }],
      },
      sourceVersion: "linkedin-v2",
    });

    projectPendingRawEvents(db);

    const renamedRow = db.orm().get<{
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT sender_name, conversation_name
      FROM messages
      WHERE platform_message_id = 'reply'
    `);
    expect(renamedRow).toEqual({
      sender_name: "Ava Zhang",
      conversation_name: "Investor thread",
    });

    const ftsRow = db.orm().get<{
      sender_name: string;
      conversation_name: string;
      attachment_text: string;
    }>(sql`
      SELECT sender_name, conversation_name, attachment_text
      FROM messages_fts
      WHERE message_id = (
        SELECT id FROM messages WHERE platform_message_id = 'reply'
      )
    `);
    expect(ftsRow).toEqual({
      sender_name: "Ava Zhang",
      conversation_name: "Investor thread",
      attachment_text: expect.stringContaining("agenda.pdf"),
    });

    db.close();
  });

  it("updates attachments incrementally without leaving orphan rows", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contact-attachments",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contact-attachments",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "email", value: "ava@example.com", deterministic: true }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "conversation-attachments",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "conversation-attachments",
      payload: {
        sourceConversationKey: "thread-attachments",
        conversationType: "dm",
        participants: [{ sourceEntityKey: "contacts:ava" }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-attachments-v1",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 3,
      dedupeKey: "message-attachments-v1",
      payload: {
        sourceMessageKey: "message-attachments",
        sourceConversationKey: "thread-attachments",
        senderSourceKey: "contacts:ava",
        sentAt: 3,
        content: "first attachment set",
        attachments: [
          { id: "att-1", filename: "one.txt" },
          { id: "att-2", filename: "two.txt" },
        ],
      },
      sourceVersion: "test-v1",
    });

    projectPendingRawEvents(db);

    db.insertRawEvent({
      id: "message-attachments-v2",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "message_created",
      observedAt: 4,
      dedupeKey: "message-attachments-v2",
      payload: {
        sourceMessageKey: "message-attachments",
        sourceConversationKey: "thread-attachments",
        senderSourceKey: "contacts:ava",
        sentAt: 4,
        content: "second attachment set",
        attachments: [
          { id: "att-2", filename: "two-updated.txt" },
          { id: "att-3", filename: "three.txt" },
        ],
      },
      sourceVersion: "test-v1",
    });

    projectPendingRawEvents(db);

    const attachmentRows = db.orm().all<{
      source_attachment_key: string;
      filename: string | null;
    }>(sql`
      SELECT source_attachment_key, filename
      FROM message_attachments
      ORDER BY source_attachment_key ASC
    `);

    expect(attachmentRows).toEqual([
      { source_attachment_key: "att-2", filename: "two-updated.txt" },
      { source_attachment_key: "att-3", filename: "three.txt" },
    ]);

    db.close();
  });
});

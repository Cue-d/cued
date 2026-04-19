import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  projectDeferredRange,
  projectPendingRawEvents,
  projectRealtimeRange,
  rebuildProjectedState,
} from "./projector.js";

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

  it("fails with raw-event context for unsupported normalized schemas", () => {
    const db = createDb();

    db.orm().run(sql`
      INSERT INTO raw_events (
        id,
        platform,
        account_key,
        entity_kind,
        event_kind,
        observed_at,
        dedupe_key,
        payload_json,
        normalized_schema,
        provenance_json,
        source_version
      ) VALUES (
        'unsupported-schema',
        'linkedin',
        'default',
        'message',
        'created',
        1710000000000,
        'linkedin:unsupported-schema',
        ${JSON.stringify({
          sourceMessageKey: "msg-unsupported",
          sourceConversationKey: "thread-unsupported",
          senderSourceKey: "contacts:test",
          sentAt: 1_710_000_000_000,
          content: "unsupported",
          service: "linkedin",
          isFromMe: false,
        })},
        'message.created@99',
        ${JSON.stringify({
          acquisitionMode: "realtime",
          providerApiVersion: "2026-03",
        })},
        'linkedin-v99'
      )
    `);

    expect(() => projectPendingRawEvents(db)).toThrowError(
      /Failed to normalize raw event \(row 1, event unsupported-schema, linkedin\/default, message:created, schema message\.created@99, sourceVersion linkedin-v99, providerApiVersion 2026-03, acquisitionMode realtime\): Unsupported normalized raw event schema 'message\.created@99'/,
    );

    db.close();
  });

  it("projects legacy raw events without normalized schemas", () => {
    const db = createDb();

    db.orm().run(sql`
      INSERT INTO raw_events (
        id,
        platform,
        account_key,
        entity_kind,
        event_kind,
        observed_at,
        dedupe_key,
        payload_json,
        normalized_schema,
        provenance_json,
        source_version
      ) VALUES (
        'legacy-message-created',
        'linkedin',
        'default',
        'message',
        'message_created',
        1710000000000,
        'linkedin:legacy-message-created',
        ${JSON.stringify({
          sourceMessageKey: "msg-legacy",
          sourceConversationKey: "thread-legacy",
          senderSourceKey: "contacts:test",
          sentAt: 1_710_000_000_000,
          content: "legacy message",
          service: "linkedin",
          isFromMe: false,
        })},
        NULL,
        NULL,
        'linkedin-v1'
      )
    `);

    expect(() => projectPendingRawEvents(db)).not.toThrow();
    const rows = db.orm().all<{ content: string | null }>(sql`
      SELECT content
      FROM messages
      WHERE platform_message_id = 'msg-legacy'
    `);
    expect(rows).toEqual([{ content: "legacy message" }]);

    db.close();
  });

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
      eventKind: "added",
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
      eventKind: "created",
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
      eventKind: "added",
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

  it("updates timeline event subject source keys on re-projection conflicts", () => {
    const db = createDb();
    const observedAt = 1_710_000_000_000;

    db.insertRawEvents([
      {
        id: "contacts-ava",
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt,
        dedupeKey: "contacts:ava",
        payload: {
          sourceEntityKey: "contacts:ava",
          fields: { display_name: "Ava Chen" },
          handles: [],
        },
        sourceVersion: "contacts-v1",
      },
      {
        id: "timeline-initial",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "timeline_event",
        eventKind: "system_message",
        observedAt: observedAt + 1,
        dedupeKey: "linkedin:timeline:membership",
        payload: {
          sourceEventKey: "timeline:membership",
          sourceConversationKey: "thread-1",
          eventKind: "system_message",
          eventAt: observedAt + 1,
          text: "Ava joined",
        },
        sourceVersion: "linkedin-v1",
      },
      {
        id: "timeline-updated",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "timeline_event",
        eventKind: "system_message",
        observedAt: observedAt + 2,
        dedupeKey: "linkedin:timeline:membership:updated",
        payload: {
          sourceEventKey: "timeline:membership",
          sourceConversationKey: "thread-1",
          eventKind: "system_message",
          eventAt: observedAt + 2,
          text: "Ava joined",
          subjectSourceKey: "contacts:ava",
        },
        sourceVersion: "linkedin-v1",
      },
    ]);

    projectPendingRawEvents(db);

    const rows = db.orm().all<{ subject_source_key: string | null }>(sql`
      SELECT subject_source_key
      FROM timeline_events
      WHERE source_event_key = 'timeline:membership'
    `);
    expect(rows).toEqual([{ subject_source_key: "contacts:ava" }]);

    db.close();
  });

  it("uses system timeline notices as the latest conversation summary activity", () => {
    const db = createDb();
    const observedAt = 1_710_050_000_000;

    db.insertRawEvents([
      {
        id: "conversation-system-summary",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt,
        dedupeKey: "conversation:system-summary",
        payload: {
          sourceConversationKey: "thread-system-summary",
          conversationType: "dm",
          displayName: "Ava Chen",
          participants: [{ sourceEntityKey: "linkedin:urn:li:member:ACoAAA1" }],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "message-system-summary",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: observedAt + 1,
        dedupeKey: "message:system-summary",
        payload: {
          sourceMessageKey: "msg-system-summary",
          sourceConversationKey: "thread-system-summary",
          senderSourceKey: "linkedin:urn:li:member:ACoAAA1",
          sentAt: observedAt + 1,
          content: "older human message",
          isFromMe: false,
        },
        sourceVersion: "test-v1",
      },
      {
        id: "timeline-system-summary",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "timeline_event",
        eventKind: "system_message",
        observedAt: observedAt + 2,
        dedupeKey: "timeline:system-summary",
        payload: {
          sourceEventKey: "timeline:system-summary",
          sourceConversationKey: "thread-system-summary",
          eventKind: "system_message",
          eventAt: observedAt + 5,
          text: "Ava renamed the conversation",
        },
        sourceVersion: "test-v1",
      },
    ]);

    projectPendingRawEvents(db);

    const conversationRow = db.orm().get<{
      last_message_id: string | null;
      last_message_at: number | null;
      last_message_preview: string | null;
    }>(sql`
      SELECT last_message_id, last_message_at, last_message_preview
      FROM conversations
      WHERE source_conversation_key = 'thread-system-summary'
    `);

    expect(conversationRow).toEqual({
      last_message_id: null,
      last_message_at: observedAt + 5,
      last_message_preview: "Ava renamed the conversation",
    });

    db.close();
  });

  it("projects call raw events into typed timeline rows and conversation summaries", () => {
    const db = createDb();
    const observedAt = 1_710_060_000_000;

    db.insertRawEvents([
      {
        id: "imessage-contact-call",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt,
        dedupeKey: "imessage:contact:+14155550123",
        payload: {
          sourceEntityKey: "imessage:+14155550123",
          fields: { display_name: "Ava Chen" },
          handles: [{ type: "phone", value: "+14155550123", deterministic: true }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "imessage-conversation-call",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: observedAt + 1,
        dedupeKey: "imessage:conversation:1",
        payload: {
          sourceConversationKey: "1",
          conversationType: "dm",
          displayName: "Ava Chen",
          participants: [{ sourceEntityKey: "imessage:+14155550123" }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "imessage-call",
        platform: "imessage",
        accountKey: "local",
        entityKind: "call",
        eventKind: "observed",
        observedAt: observedAt + 2,
        dedupeKey: "imessage:call:call-1",
        payload: {
          sourceCallKey: "call-1",
          sourceConversationKey: "1",
          provider: "facetime",
          providerCallType: "8",
          direction: "incoming",
          medium: "video",
          status: "declined",
          startedAt: observedAt + 10,
          endedAt: observedAt + 10,
          durationSeconds: 0,
          initiatorSourceKey: "imessage:+14155550123",
          primaryRemoteSourceKey: "imessage:+14155550123",
          remoteAddress: "+14155550123",
          remoteDisplayName: "Ava Chen",
          disconnectedCause: "21",
        },
        sourceVersion: "imessage-v1",
      },
    ]);

    projectPendingRawEvents(db);

    const timelineRow = db.orm().get<{
      system_kind: string | null;
      call_provider: string | null;
      call_direction: string | null;
      call_status: string | null;
      call_medium: string | null;
      call_started_at: number | null;
      call_ended_at: number | null;
      call_duration_seconds: number | null;
      call_disconnected_cause: string | null;
      subject_source_key: string | null;
      text: string | null;
    }>(sql`
      SELECT
        system_kind,
        call_provider,
        call_direction,
        call_status,
        call_medium,
        call_started_at,
        call_ended_at,
        call_duration_seconds,
        call_disconnected_cause,
        subject_source_key,
        text
      FROM timeline_events
      WHERE source_event_key = 'call-1'
    `);
    expect(timelineRow).toEqual({
      system_kind: "call",
      call_provider: "facetime",
      call_direction: "incoming",
      call_status: "declined",
      call_medium: "video",
      call_started_at: observedAt + 10,
      call_ended_at: observedAt + 10,
      call_duration_seconds: 0,
      call_disconnected_cause: "21",
      subject_source_key: "imessage:+14155550123",
      text: "Declined FaceTime video call",
    });

    const conversationRow = db.orm().get<{
      last_message_preview: string | null;
      last_message_at: number | null;
    }>(sql`
      SELECT last_message_preview, last_message_at
      FROM conversations
      WHERE source_conversation_key = '1'
    `);
    expect(conversationRow).toEqual({
      last_message_preview: "Declined FaceTime video call",
      last_message_at: observedAt + 10,
    });

    db.close();
  });

  it("renders unknown call providers without duplicating 'Call call'", () => {
    const db = createDb();
    const observedAt = 1_710_070_000_000;

    db.insertRawEvents([
      {
        id: "imessage-contact-call-unknown",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt,
        dedupeKey: "imessage:contact:+14155550124",
        payload: {
          sourceEntityKey: "imessage:+14155550124",
          fields: { display_name: "Ava Chen" },
          handles: [{ type: "phone", value: "+14155550124", deterministic: true }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "imessage-conversation-call-unknown",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: observedAt + 1,
        dedupeKey: "imessage:conversation:unknown-provider",
        payload: {
          sourceConversationKey: "unknown-provider",
          conversationType: "dm",
          displayName: "Ava Chen",
          participants: [{ sourceEntityKey: "imessage:+14155550124" }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "imessage-call-unknown-provider",
        platform: "imessage",
        accountKey: "local",
        entityKind: "call",
        eventKind: "observed",
        observedAt: observedAt + 2,
        dedupeKey: "imessage:call:unknown-provider",
        payload: {
          sourceCallKey: "unknown-provider",
          sourceConversationKey: "unknown-provider",
          provider: "unknown",
          direction: "incoming",
          medium: "audio",
          status: "missed",
          startedAt: observedAt + 10,
          endedAt: observedAt + 10,
          durationSeconds: 0,
          initiatorSourceKey: "imessage:+14155550124",
          primaryRemoteSourceKey: "imessage:+14155550124",
          remoteAddress: "+14155550124",
          remoteDisplayName: "Ava Chen",
        },
        sourceVersion: "imessage-v1",
      },
    ]);

    projectPendingRawEvents(db);

    const timelineRow = db.orm().get<{ text: string | null }>(sql`
      SELECT text
      FROM timeline_events
      WHERE source_event_key = 'unknown-provider'
    `);
    expect(timelineRow).toEqual({
      text: "Missed Call",
    });

    db.close();
  });

  it("keeps FTS rowids aligned when reprojecting an existing message", () => {
    const db = createDb();
    const observedAt = 1_710_200_000_000;

    db.insertRawEvent({
      id: "contact",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt,
      dedupeKey: "linkedin:contact:ava",
      payload: {
        sourceEntityKey: "linkedin:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "email", value: "ava@cued.com", deterministic: true }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "conversation",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: observedAt + 1,
      dedupeKey: "linkedin:conversation:thread-1",
      payload: {
        sourceConversationKey: "thread-1",
        conversationType: "dm",
        service: "linkedin",
        participants: [{ sourceEntityKey: "linkedin:ava" }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "message-1",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: observedAt + 2,
      dedupeKey: "linkedin:message:1",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "thread-1",
        senderSourceKey: "linkedin:ava",
        sentAt: observedAt + 2,
        content: "before refresh",
        service: "linkedin",
        isFromMe: false,
      },
      sourceVersion: "linkedin-v1",
    });

    projectPendingRawEvents(db);

    db.insertRawEvent({
      id: "message-1-refresh",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "updated",
      observedAt: observedAt + 3,
      dedupeKey: "linkedin:message:1:refresh",
      payload: {
        sourceMessageKey: "msg-1",
        sourceConversationKey: "thread-1",
        senderSourceKey: "linkedin:ava",
        sentAt: observedAt + 2,
        content: "after refresh",
        service: "linkedin",
        isFromMe: false,
        isEdited: true,
        editedAt: observedAt + 3,
      },
      sourceVersion: "linkedin-v2",
    });

    projectPendingRawEvents(db);

    const row = db.orm().get<{
      message_rowid: number;
      fts_rowid: number;
      content: string | null;
      fts_rows: number;
    }>(sql`
      SELECT
        m.rowid AS message_rowid,
        f.rowid AS fts_rowid,
        m.content,
        (
          SELECT COUNT(*)
          FROM messages_fts f2
          WHERE f2.message_id = m.id
        ) AS fts_rows
      FROM messages m
      JOIN messages_fts f ON f.message_id = m.id
      WHERE m.platform = 'linkedin'
        AND m.account_key = 'default'
        AND m.platform_message_id = 'msg-1'
    `);

    expect(row).toEqual({
      message_rowid: expect.any(Number),
      fts_rowid: expect.any(Number),
      content: "after refresh",
      fts_rows: 1,
    });
    expect(row?.fts_rowid).toBe(row?.message_rowid);

    db.close();
  });

  it("does not let later raw handle observations clobber a resolved contact name", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contacts-ava",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:ava",
      payload: {
        sourceEntityKey: "contacts:ava",
        fields: { display_name: "Ava Chen" },
        handles: [{ type: "phone", value: "(555) 123-4567", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "imessage-contact-ava",
      platform: "imessage",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "imessage:contact:ava",
      payload: {
        sourceEntityKey: "imessage:+15551234567",
        fields: { display_name: "+15551234567" },
        handles: [
          { type: "phone", value: "+15551234567", deterministic: true },
          { type: "imessage_handle", value: "+15551234567", deterministic: true },
        ],
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "imessage-conversation-ava",
      platform: "imessage",
      accountKey: "local",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 3,
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
      accountKey: "local",
      entityKind: "message",
      eventKind: "created",
      observedAt: 4,
      dedupeKey: "imessage:message:ava",
      payload: {
        sourceMessageKey: "message-ava",
        sourceConversationKey: "chat-ava",
        senderSourceKey: "imessage:+15551234567",
        sentAt: 4,
        content: "hello from imessage",
        service: "iMessage",
        isFromMe: false,
      },
      sourceVersion: "imessage-v1",
    });

    projectPendingRawEvents(db);

    const row = db.orm().get<{
      contact_name: string | null;
      participant_name: string | null;
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT
        c.name AS contact_name,
        cp.participant_name,
        m.sender_name,
        m.conversation_name
      FROM contacts c
      JOIN conversation_participants cp ON cp.contact_id = c.id
      JOIN messages m ON m.sender_contact_id = c.id
      WHERE cp.source_participant_key = 'imessage:+15551234567'
    `);
    expect(row).toEqual({
      contact_name: "Ava Chen",
      participant_name: "Ava Chen",
      sender_name: "Ava Chen",
      conversation_name: "Ava Chen",
    });

    db.close();
  });

  it("merges iMessage phone stubs into later Contacts observations when formats differ", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "imessage-conversation-parent",
      platform: "imessage",
      accountKey: "local",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "imessage:conversation:parent",
      payload: {
        sourceConversationKey: "chat-parent",
        conversationType: "dm",
        service: "iMessage",
        displayName: "+17737441662",
        participants: [{ sourceEntityKey: "imessage:+17737441662" }],
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "imessage-message-parent",
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "created",
      observedAt: 2,
      dedupeKey: "imessage:message:parent",
      payload: {
        sourceMessageKey: "message-parent",
        sourceConversationKey: "chat-parent",
        senderSourceKey: "imessage:+17737441662",
        sentAt: 2,
        content: "hello from parent",
        service: "iMessage",
        isFromMe: false,
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "contacts-parent",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 3,
      dedupeKey: "contacts:parent",
      payload: {
        sourceEntityKey: "contacts:parent",
        fields: { display_name: "Parent" },
        handles: [{ type: "phone", value: "773 744 1662", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });

    projectPendingRawEvents(db);

    const contactRows = db.orm().all<{ name: string | null }>(sql`
      SELECT name
      FROM contacts
      ORDER BY id ASC
    `);
    expect(contactRows).toEqual([{ name: "Parent" }]);

    const row = db.orm().get<{
      sender_name: string | null;
      participant_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT
        m.sender_name,
        cp.participant_name,
        c.name AS conversation_name
      FROM messages m
      JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.platform_message_id = 'message-parent'
    `);
    expect(row).toEqual({
      sender_name: "Parent",
      participant_name: "Parent",
      conversation_name: "Parent",
    });

    db.close();
  });

  it("matches iMessage email aliases case-insensitively when contacts land later", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "imessage-conversation-email",
      platform: "imessage",
      accountKey: "local",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "imessage:conversation:email",
      payload: {
        sourceConversationKey: "chat-email",
        conversationType: "dm",
        service: "iMessage",
        displayName: "Casey@Example.com",
        participants: [{ sourceEntityKey: "imessage:Casey@Example.com" }],
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "imessage-message-email",
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "created",
      observedAt: 2,
      dedupeKey: "imessage:message:email",
      payload: {
        sourceMessageKey: "message-email",
        sourceConversationKey: "chat-email",
        senderSourceKey: "imessage:Casey@Example.com",
        sentAt: 2,
        content: "hello from email",
        service: "iMessage",
        isFromMe: false,
      },
      sourceVersion: "imessage-v1",
    });
    db.insertRawEvent({
      id: "contacts-email",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 3,
      dedupeKey: "contacts:email",
      payload: {
        sourceEntityKey: "contacts:email",
        fields: { display_name: "Casey Contact" },
        handles: [{ type: "email", value: "casey@example.com", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });

    projectPendingRawEvents(db);

    const contactRows = db.orm().all<{ name: string | null }>(sql`
      SELECT name
      FROM contacts
      ORDER BY id ASC
    `);
    expect(contactRows).toEqual([{ name: "Casey Contact" }]);

    const row = db.orm().get<{ sender_name: string | null }>(sql`
      SELECT sender_name
      FROM messages
      WHERE platform_message_id = 'message-email'
    `);
    expect(row).toEqual({ sender_name: "Casey Contact" });

    db.close();
  });

  it("uses a DM conversation name to resolve sender identities when contact records stay raw", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "signal-contact",
      platform: "signal",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "signal:contact:+14155550123",
      payload: {
        sourceEntityKey: "signal:+14155550123",
        fields: { display_name: "+14155550123" },
        handles: [{ type: "phone", value: "+14155550123", deterministic: true }],
      },
      sourceVersion: "signal-v1",
    });
    db.insertRawEvent({
      id: "signal-conversation",
      platform: "signal",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "signal:conversation:dm-ava",
      payload: {
        sourceConversationKey: "signal:dm-ava",
        conversationType: "dm",
        displayName: "Ava Chen",
        service: "signal",
        participants: [{ sourceEntityKey: "signal:+14155550123" }],
      },
      sourceVersion: "signal-v1",
    });
    db.insertRawEvent({
      id: "signal-message",
      platform: "signal",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 3,
      dedupeKey: "signal:message:1",
      payload: {
        sourceMessageKey: "signal:message:1",
        sourceConversationKey: "signal:dm-ava",
        senderSourceKey: "signal:+14155550123",
        sentAt: 3,
        content: "hello from signal",
        service: "signal",
        isFromMe: false,
      },
      sourceVersion: "signal-v1",
    });

    projectPendingRawEvents(db);

    const row = db.orm().get<{
      contact_name: string | null;
      participant_name: string | null;
      participant_names: string | null;
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT
        c.name AS contact_name,
        cp.participant_name,
        conv.participant_names,
        m.sender_name,
        m.conversation_name
      FROM contacts c
      JOIN conversation_participants cp ON cp.contact_id = c.id
      JOIN conversations conv ON conv.id = cp.conversation_id
      JOIN messages m ON m.sender_contact_id = c.id
      WHERE cp.source_participant_key = 'signal:+14155550123'
    `);
    expect(row).toEqual({
      contact_name: "+14155550123",
      participant_name: "Ava Chen",
      participant_names: "Ava Chen",
      sender_name: "Ava Chen",
      conversation_name: "Ava Chen",
    });

    db.close();
  });

  it("treats Signal UUID contact names as raw identifiers in SQL-backed sender resolution", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "signal-contact-uuid",
      platform: "signal",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "signal:contact:uuid",
      payload: {
        sourceEntityKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678",
        fields: { display_name: "a1b2c3d4-e5f6-1234-9abc-def012345678" },
        handles: [
          {
            type: "signal_id",
            value: "a1b2c3d4-e5f6-1234-9abc-def012345678",
            deterministic: true,
          },
        ],
      },
      sourceVersion: "signal-v1",
    });
    db.insertRawEvent({
      id: "signal-conversation-uuid",
      platform: "signal",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "signal:conversation:uuid",
      payload: {
        sourceConversationKey: "signal:dm-uuid",
        conversationType: "dm",
        displayName: "Ava Chen",
        service: "signal",
        participants: [{ sourceEntityKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678" }],
      },
      sourceVersion: "signal-v1",
    });
    db.insertRawEvent({
      id: "signal-message-uuid",
      platform: "signal",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 3,
      dedupeKey: "signal:message:uuid",
      payload: {
        sourceMessageKey: "signal:message:uuid",
        sourceConversationKey: "signal:dm-uuid",
        senderSourceKey: "signal:a1b2c3d4-e5f6-1234-9abc-def012345678",
        sentAt: 3,
        content: "hello from signal uuid",
        service: "signal",
        isFromMe: false,
      },
      sourceVersion: "signal-v1",
    });

    projectPendingRawEvents(db);

    const row = db.orm().get<{
      contact_name: string | null;
      participant_name: string | null;
      participant_names: string | null;
      sender_name: string | null;
      conversation_name: string | null;
    }>(sql`
      SELECT
        c.name AS contact_name,
        cp.participant_name,
        conv.participant_names,
        m.sender_name,
        m.conversation_name
      FROM contacts c
      JOIN conversation_participants cp ON cp.contact_id = c.id
      JOIN conversations conv ON conv.id = cp.conversation_id
      JOIN messages m ON m.sender_contact_id = c.id
      WHERE cp.source_participant_key = 'signal:a1b2c3d4-e5f6-1234-9abc-def012345678'
    `);
    expect(row).toEqual({
      contact_name: "a1b2c3d4-e5f6-1234-9abc-def012345678",
      participant_name: "Ava Chen",
      participant_names: "Ava Chen",
      sender_name: "Ava Chen",
      conversation_name: "Ava Chen",
    });

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
      eventKind: "created",
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

  it("keeps inserted-range projection canonical before deferred catchup reruns", () => {
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
        eventKind: "created",
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
      participant_names: "Ava Chen",
    });

    const hotMessage = db.orm().get<{
      content: string | null;
      sender_name: string | null;
      sender_contact_id: string | null;
    }>(sql`
      SELECT content, sender_name, sender_contact_id
      FROM messages
      WHERE platform_message_id = 'message-hot-path'
    `);
    expect(hotMessage).toEqual({
      content: "hot path preview",
      sender_name: "Ava Chen",
      sender_contact_id: expect.any(String),
    });

    const hotFtsRows = db
      .orm()
      .all<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
    expect(hotFtsRows).toEqual([{ count: 1 }]);

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

  it("normalizes attachment-only placeholders on realtime projection", () => {
    const db = createDb();

    const insertResult = db.insertRawEvents([
      {
        id: "conversation-realtime-attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "conversation-realtime-attachment",
        payload: {
          sourceConversationKey: "imessage:chat:attachment",
          conversationType: "dm",
          participants: [],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "message-realtime-attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        observedAt: 2,
        dedupeKey: "message-realtime-attachment",
        payload: {
          sourceMessageKey: "imessage:message:attachment",
          sourceConversationKey: "imessage:chat:attachment",
          senderSourceKey: "imessage:+14155550123",
          sentAt: 2,
          content: "[attachment]",
          isFromMe: false,
          attachments: [
            {
              id: "attachment-1",
              kind: "file",
              filename: "deck.pdf",
              local_path: "~/Library/Messages/Attachments/deck.pdf",
            },
          ],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "reaction-realtime-attachment",
        platform: "imessage",
        accountKey: "local",
        entityKind: "reaction",
        eventKind: "added",
        observedAt: 3,
        dedupeKey: "reaction-realtime-attachment",
        payload: {
          sourceMessageKey: "imessage:message:attachment",
          sourceConversationKey: "imessage:chat:attachment",
          reactorSourceKey: "imessage:+14155550123",
          emoji: "👍",
          timestamp: 3,
          isActive: true,
        },
        sourceVersion: "test-v1",
      },
    ]);

    projectRealtimeRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
      batchSize: 10,
    });

    const messageRow = db.orm().get<{
      content: string | null;
      attachment_count: number;
      reaction_count: number;
    }>(sql`
      SELECT content, attachment_count, reaction_count
      FROM messages
      WHERE platform_message_id = 'imessage:message:attachment'
    `);
    const conversationRow = db.orm().get<{ last_message_preview: string | null }>(sql`
      SELECT last_message_preview
      FROM conversations
      WHERE source_conversation_key = 'imessage:chat:attachment'
    `);

    expect(messageRow).toEqual({
      content: "[attachment: deck.pdf]",
      attachment_count: 1,
      reaction_count: 1,
    });
    expect(conversationRow).toEqual({
      last_message_preview: "[attachment: deck.pdf]",
    });

    db.close();
  });

  it("realtime projection resolves imessage sender_contact_id and sender_name", () => {
    const db = createDb();
    const insertResult = db.insertRawEvents([
      {
        id: "rt-imessage-contact",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "rt-imessage-contact",
        payload: {
          sourceEntityKey: "imessage:+15559876543",
          fields: { display_name: "Casey IM" },
          handles: [
            { type: "phone", value: "+15559876543", deterministic: true },
            { type: "imessage_handle", value: "+15559876543", deterministic: true },
          ],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "rt-imessage-conv",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 2,
        dedupeKey: "rt-imessage-conv",
        payload: {
          sourceConversationKey: "rt-imessage-chat",
          conversationType: "dm",
          service: "iMessage",
          displayName: "+15559876543",
          participants: [{ sourceEntityKey: "imessage:+15559876543" }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "rt-imessage-msg",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        observedAt: 3,
        dedupeKey: "rt-imessage-msg",
        payload: {
          sourceMessageKey: "rt-imessage-msg-key",
          sourceConversationKey: "rt-imessage-chat",
          senderSourceKey: "imessage:+15559876543",
          sentAt: 3,
          content: "hi",
          service: "iMessage",
          isFromMe: false,
        },
        sourceVersion: "imessage-v1",
      },
    ]);
    projectRealtimeRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
      batchSize: 10,
    });
    const row = db.orm().get<{
      sender_name: string | null;
      sender_contact_id: string | null;
    }>(sql`
      SELECT sender_name, sender_contact_id
      FROM messages
      WHERE platform_message_id = 'rt-imessage-msg-key'
    `);
    expect(row).toEqual({
      sender_name: "Casey IM",
      sender_contact_id: expect.any(String),
    });
    db.close();
  });

  it("realtime projection backfills sender_name when the contact observation arrives after the message in one batch", () => {
    const db = createDb();
    const insertResult = db.insertRawEvents([
      {
        id: "order-imessage-conv",
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "order-imessage-conv",
        payload: {
          sourceConversationKey: "order-imessage-chat",
          conversationType: "dm",
          service: "iMessage",
          displayName: "+15551110000",
          participants: [{ sourceEntityKey: "imessage:+15551110000" }],
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "order-imessage-msg",
        platform: "imessage",
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        observedAt: 2,
        dedupeKey: "order-imessage-msg",
        payload: {
          sourceMessageKey: "order-imessage-msg-key",
          sourceConversationKey: "order-imessage-chat",
          senderSourceKey: "imessage:+15551110000",
          sentAt: 2,
          content: "out of order",
          service: "iMessage",
          isFromMe: false,
        },
        sourceVersion: "imessage-v1",
      },
      {
        id: "order-imessage-contact",
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: 3,
        dedupeKey: "order-imessage-contact",
        payload: {
          sourceEntityKey: "imessage:+15551110000",
          fields: { display_name: "Later Contact" },
          handles: [
            { type: "phone", value: "+15551110000", deterministic: true },
            { type: "imessage_handle", value: "+15551110000", deterministic: true },
          ],
        },
        sourceVersion: "imessage-v1",
      },
    ]);
    projectRealtimeRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
      batchSize: 10,
    });
    const row = db.orm().get<{
      sender_name: string | null;
      sender_contact_id: string | null;
    }>(sql`
      SELECT sender_name, sender_contact_id
      FROM messages
      WHERE platform_message_id = 'order-imessage-msg-key'
    `);
    expect(row).toEqual({
      sender_name: "Later Contact",
      sender_contact_id: expect.any(String),
    });
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
      eventKind: "created",
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
      eventKind: "created",
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
      eventKind: "created",
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

  it("normalizes deferred attachment-only placeholders and preserves real text", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "conversation-placeholder-policy",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "conversation-placeholder-policy",
      payload: {
        sourceConversationKey: "thread-placeholder-policy",
        conversationType: "dm",
        participants: [],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-placeholder-mime",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 2,
      dedupeKey: "message-placeholder-mime",
      payload: {
        sourceMessageKey: "message-placeholder-mime",
        sourceConversationKey: "thread-placeholder-policy",
        sentAt: 2,
        content: "[attachment]",
        attachments: [{ id: "att-pdf", kind: "file", mime_type: "application/pdf" }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-placeholder-text",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 3,
      dedupeKey: "message-placeholder-text",
      payload: {
        sourceMessageKey: "message-placeholder-text",
        sourceConversationKey: "thread-placeholder-policy",
        sentAt: 3,
        content: "Quarterly memo",
        attachments: [{ id: "att-caption", filename: "memo.pdf" }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-placeholder-multi",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 4,
      dedupeKey: "message-placeholder-multi",
      payload: {
        sourceMessageKey: "message-placeholder-multi",
        sourceConversationKey: "thread-placeholder-policy",
        sentAt: 4,
        content: "",
        attachments: [
          { id: "att-1", filename: "one.txt" },
          { id: "att-2", filename: "two.txt" },
        ],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-placeholder-filename",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 5,
      dedupeKey: "message-placeholder-filename",
      payload: {
        sourceMessageKey: "message-placeholder-filename",
        sourceConversationKey: "thread-placeholder-policy",
        sentAt: 5,
        content: "",
        attachments: [{ id: "att-deck", filename: "deck.pdf" }],
      },
      sourceVersion: "test-v1",
    });

    projectPendingRawEvents(db);

    const messageRows = db.orm().all<{ platform_message_id: string; content: string | null }>(sql`
      SELECT platform_message_id, content
      FROM messages
      WHERE conversation_id = (
        SELECT id FROM conversations WHERE source_conversation_key = 'thread-placeholder-policy'
      )
      ORDER BY sent_at ASC
    `);
    const conversationRow = db.orm().get<{ last_message_preview: string | null }>(sql`
      SELECT last_message_preview
      FROM conversations
      WHERE source_conversation_key = 'thread-placeholder-policy'
    `);

    expect(messageRows).toEqual([
      { platform_message_id: "message-placeholder-mime", content: "[pdf attachment]" },
      { platform_message_id: "message-placeholder-text", content: "Quarterly memo" },
      { platform_message_id: "message-placeholder-multi", content: "[2 attachments]" },
      {
        platform_message_id: "message-placeholder-filename",
        content: "[attachment: deck.pdf]",
      },
    ]);
    expect(conversationRow).toEqual({
      last_message_preview: "[attachment: deck.pdf]",
    });

    db.close();
  });

  it("applies manual contact merge decisions during rebuild", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contacts-ava-primary",
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contacts:ava-primary",
      payload: {
        sourceEntityKey: "contacts:ava-primary",
        fields: {
          display_name: "Ava Chen",
          company: "Prime Ventures",
        },
        handles: [{ type: "phone", value: "+1 (555) 123-4567", deterministic: true }],
      },
      sourceVersion: "contacts-v1",
    });
    db.insertRawEvent({
      id: "linkedin-ava-duplicate",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "linkedin:ava-duplicate",
      payload: {
        sourceEntityKey: "linkedin:ava-duplicate",
        sourceProfileUrl: "https://www.linkedin.com/in/ava-chen/",
        fields: {
          display_name: "Ava Chen",
          company: "Acme Ventures",
          photo_url: "https://example.com/linkedin-ava.jpg",
        },
        handles: [{ type: "linkedin", value: "urn:li:person:ava-chen", deterministic: true }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "linkedin-conversation-ava",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 3,
      dedupeKey: "linkedin:conversation:ava",
      payload: {
        sourceConversationKey: "thread-ava",
        conversationType: "dm",
        displayName: "Ava Chen",
        participants: [{ sourceEntityKey: "linkedin:ava-duplicate" }],
      },
      sourceVersion: "linkedin-v1",
    });
    db.insertRawEvent({
      id: "linkedin-message-ava",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 4,
      dedupeKey: "linkedin:message:ava",
      payload: {
        sourceMessageKey: "msg-ava",
        sourceConversationKey: "thread-ava",
        senderSourceKey: "linkedin:ava-duplicate",
        sentAt: 4,
        content: "hello from linkedin",
        isFromMe: false,
      },
      sourceVersion: "linkedin-v1",
    });

    rebuildProjectedState(db);

    const contactsBefore = db.orm().all<{ id: string; name: string | null }>(sql`
      SELECT id, name
      FROM contacts
      ORDER BY created_at ASC, id ASC
    `);
    expect(contactsBefore).toHaveLength(2);

    const primaryContactId = contactsBefore[0]!.id;
    const secondaryContactId = contactsBefore[1]!.id;

    expect(
      db.recordContactMergeDecision({
        primaryContactId,
        secondaryContactId,
        reason: "manual merge",
      }),
    ).toEqual({
      decisionId: expect.any(String),
      primaryContactId,
      secondaryContactId,
      canonicalContactId: primaryContactId,
    });

    const projection = rebuildProjectedState(db);
    expect(projection.contacts).toBe(1);

    expect(
      db.orm().get<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM contacts
      `),
    ).toEqual({ count: 1 });
    expect(
      db.orm().get<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM contact_sources
        WHERE contact_id = ${primaryContactId}
      `),
    ).toEqual({ count: 2 });
    expect(
      db.orm().get<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM contact_handles
        WHERE contact_id = ${primaryContactId}
      `),
    ).toEqual({ count: 2 });
    expect(
      db.orm().get<{ company: string | null; photo_url: string | null }>(sql`
        SELECT company, photo_url
        FROM contacts
        WHERE id = ${primaryContactId}
      `),
    ).toEqual({
      company: "Prime Ventures",
      photo_url: "https://example.com/linkedin-ava.jpg",
    });
    expect(
      db.orm().get<{ sender_contact_id: string | null }>(sql`
        SELECT sender_contact_id
        FROM messages
        WHERE platform_message_id = 'msg-ava'
      `),
    ).toEqual({ sender_contact_id: primaryContactId });

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
      eventKind: "created",
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

    const removedAttachment = db.orm().get<{ id: string }>(sql`
      SELECT id
      FROM message_attachments
      WHERE source_attachment_key = 'message-attachments:att-1'
    `);
    expect(removedAttachment?.id).toBeTruthy();
    if (!removedAttachment?.id) {
      throw new Error("expected projected attachment id");
    }
    db.upsertAttachmentContent({
      attachmentId: removedAttachment.id,
      status: "ready",
      textContent: "orphan me",
      mimeType: "text/plain",
      extractedAt: 3,
      filename: "one.txt",
      title: "One",
    });

    db.insertRawEvent({
      id: "message-attachments-v2",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
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
      {
        source_attachment_key: "message-attachments:att-2",
        filename: "two-updated.txt",
      },
      { source_attachment_key: "message-attachments:att-3", filename: "three.txt" },
    ]);
    const orphanedFts = db.orm().get<{ count: number }>(sql`
      SELECT COUNT(*) AS count
      FROM attachment_content_fts
      WHERE attachment_id = ${removedAttachment.id}
    `);
    expect(orphanedFts?.count).toBe(0);

    db.close();
  });

  it("scopes fallback attachment ids to the message so reused Slack file ids do not collide", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "slack-conversation-a",
      platform: "slack",
      accountKey: "workspace-a",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "slack-conversation-a",
      payload: {
        sourceConversationKey: "slack:T1:C_A",
        conversationType: "group",
        displayName: "alpha",
        participants: [],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "slack-conversation-b",
      platform: "slack",
      accountKey: "workspace-a",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "slack-conversation-b",
      payload: {
        sourceConversationKey: "slack:T1:C_B",
        conversationType: "group",
        displayName: "beta",
        participants: [],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "slack-message-a",
      platform: "slack",
      accountKey: "workspace-a",
      entityKind: "message",
      eventKind: "created",
      observedAt: 3,
      dedupeKey: "slack-message-a",
      payload: {
        sourceMessageKey: "slack:T1:C_A:1000.000001",
        sourceConversationKey: "slack:T1:C_A",
        sentAt: 3,
        content: "alpha attachment",
        attachments: [{ id: "F_SHARED", name: "shared.pdf" }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "slack-message-b",
      platform: "slack",
      accountKey: "workspace-a",
      entityKind: "message",
      eventKind: "created",
      observedAt: 4,
      dedupeKey: "slack-message-b",
      payload: {
        sourceMessageKey: "slack:T1:C_B:1000.000002",
        sourceConversationKey: "slack:T1:C_B",
        sentAt: 4,
        content: "beta attachment",
        attachments: [{ id: "F_SHARED", name: "shared.pdf" }],
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
      WHERE platform = 'slack' AND account_key = 'workspace-a'
      ORDER BY source_attachment_key ASC
    `);
    const messageCount = db.orm().get<{ count: number }>(sql`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE platform = 'slack' AND account_key = 'workspace-a'
    `);

    expect(messageCount?.count).toBe(2);
    expect(attachmentRows).toEqual([
      {
        source_attachment_key: "slack:T1:C_A:1000.000001:F_SHARED",
        filename: "shared.pdf",
      },
      {
        source_attachment_key: "slack:T1:C_B:1000.000002:F_SHARED",
        filename: "shared.pdf",
      },
    ]);

    db.close();
  });

  it("preserves deleted conversations locally while marking participants inactive", () => {
    const db = createDb();

    db.insertRawEvent({
      id: "contact-ava-delete",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "contact",
      eventKind: "observed",
      observedAt: 1,
      dedupeKey: "contact-ava-delete",
      payload: {
        sourceEntityKey: "linkedin:urn:li:member:ACoAAA1",
        fields: { display_name: "Ava Chen" },
        handles: [],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "conversation-delete-observed",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "observed",
      observedAt: 2,
      dedupeKey: "conversation-delete-observed",
      payload: {
        sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_DELETE",
        conversationType: "dm",
        participants: [{ sourceEntityKey: "linkedin:urn:li:member:ACoAAA1" }],
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "message-delete-observed",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "message",
      eventKind: "created",
      observedAt: 3,
      dedupeKey: "message-delete-observed",
      payload: {
        sourceMessageKey: "linkedin:urn:li:fsd_message:MSG_DELETE",
        sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_DELETE",
        senderSourceKey: "linkedin:urn:li:member:ACoAAA1",
        sentAt: 3,
        content: "preserve me",
        isFromMe: false,
      },
      sourceVersion: "test-v1",
    });
    db.insertRawEvent({
      id: "conversation-delete-removed",
      platform: "linkedin",
      accountKey: "default",
      entityKind: "conversation",
      eventKind: "removed",
      observedAt: 4,
      dedupeKey: "conversation-delete-removed",
      payload: {
        sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_DELETE",
        conversationType: "dm",
        removalReason: "deleted",
        unreadCount: 0,
        participants: [{ sourceEntityKey: "linkedin:urn:li:member:ACoAAA1" }],
      },
      sourceVersion: "test-v1",
    });

    projectPendingRawEvents(db);

    const conversationRow = db.orm().get<{
      is_active: number;
      removal_reason: string | null;
      unread_count: number;
    }>(sql`
      SELECT is_active, removal_reason, unread_count
      FROM conversations
      WHERE source_conversation_key = 'linkedin:urn:li:fs_conversation:CONV_DELETE'
    `);
    const participantRow = db.orm().get<{
      is_active: number;
      left_at: number | null;
    }>(sql`
      SELECT is_active, left_at
      FROM conversation_participants
      LIMIT 1
    `);
    const messageCount = db.orm().get<{ count: number }>(sql`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE platform_message_id = 'linkedin:urn:li:fsd_message:MSG_DELETE'
    `);

    expect(conversationRow).toEqual({
      is_active: 0,
      removal_reason: "deleted",
      unread_count: 0,
    });
    expect(participantRow).toEqual({
      is_active: 0,
      left_at: 4,
    });
    expect(messageCount?.count).toBe(1);

    db.close();
  });

  it("updates reaction counts on realtime projection", () => {
    const db = createDb();

    const insertResult = db.insertRawEvents([
      {
        id: "conversation-realtime-reaction",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: 1,
        dedupeKey: "conversation-realtime-reaction",
        payload: {
          sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_REACTION",
          conversationType: "dm",
          participants: [],
        },
        sourceVersion: "test-v1",
      },
      {
        id: "message-realtime-reaction",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 2,
        dedupeKey: "message-realtime-reaction",
        payload: {
          sourceMessageKey: "linkedin:urn:li:fsd_message:MSG_REACTION",
          sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_REACTION",
          senderSourceKey: "linkedin:urn:li:member:ACoAAA1",
          sentAt: 2,
          content: "react to this",
          isFromMe: false,
        },
        sourceVersion: "test-v1",
      },
      {
        id: "reaction-realtime-reaction",
        platform: "linkedin",
        accountKey: "default",
        entityKind: "reaction",
        eventKind: "added",
        observedAt: 3,
        dedupeKey: "reaction-realtime-reaction",
        payload: {
          sourceMessageKey: "linkedin:urn:li:fsd_message:MSG_REACTION",
          sourceConversationKey: "linkedin:urn:li:fs_conversation:CONV_REACTION",
          reactorSourceKey: "linkedin:urn:li:member:ACoAAA1",
          emoji: "👍",
          timestamp: 3,
          isActive: true,
        },
        sourceVersion: "test-v1",
      },
    ]);

    projectRealtimeRange(db, {
      startRowId: insertResult.firstInsertedRowId!,
      endRowId: insertResult.lastInsertedRowId!,
      batchSize: 10,
    });

    const messageRow = db.orm().get<{ reaction_count: number }>(sql`
      SELECT reaction_count
      FROM messages
      WHERE platform_message_id = 'linkedin:urn:li:fsd_message:MSG_REACTION'
    `);
    expect(messageRow?.reaction_count).toBe(1);

    db.close();
  });
});

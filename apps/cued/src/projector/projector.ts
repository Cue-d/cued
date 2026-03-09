import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { CuedDatabase, LocalDrizzleDatabase } from "../db/database.js";
import {
  contactFieldValues,
  contactHandles,
  contactObservations,
  contactSources,
  contacts,
  conversationObservations,
  conversationParticipants,
  conversations,
  messageEvents,
  messageReactions,
  messages,
} from "../db/schema.js";
import {
  isContactFieldName,
  type ContactFieldName,
  type ContactObservationPayload,
  type ConversationObservationPayload,
  type MessagePayload,
  type Platform,
  type ReactionPayload,
} from "../types/provider.js";

type LocalDbExecutor = Pick<
  LocalDrizzleDatabase,
  "all" | "delete" | "get" | "insert" | "run" | "select" | "update"
>;

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizeHandle(type: string, value: string): string {
  const trimmed = value.trim();
  switch (type) {
    case "email":
      return trimmed.toLowerCase();
    case "phone":
      return trimmed.replace(/[^\d+]/g, "");
    default:
      return trimmed.toLowerCase();
  }
}

function fieldPriority(platform: Platform, fieldName: ContactFieldName): number {
  if (platform === "contacts" && (fieldName === "display_name" || fieldName === "photo_url")) {
    return 100;
  }
  if (platform === "contacts") return 90;
  if (fieldName === "company") return 50;
  return 40;
}

function currentBestPriority(
  conn: LocalDbExecutor,
  contactId: string,
  fieldName: ContactFieldName,
): { priority: number; observedAt: number } | null {
  const row = conn
    .select({
      priority: contactFieldValues.priority,
      observedAt: contactFieldValues.observedAt,
    })
    .from(contactFieldValues)
    .where(and(
      eq(contactFieldValues.contactId, contactId),
      eq(contactFieldValues.fieldName, fieldName),
      eq(contactFieldValues.isCurrentBest, 1),
    ))
    .limit(1)
    .get();

  return row ?? null;
}

export function rebuildProjectedState(db: CuedDatabase): {
  contacts: number;
  conversations: number;
  messages: number;
  rawEvents: number;
} {
  const rawEvents = db.listRawEvents();
  db.clearProjectedState();

  const sourceContactMap = new Map<string, string>();
  const deterministicHandleMap = new Map<string, string>();
  const conversationMap = new Map<string, string>();

  db.orm().transaction((tx) => {
    for (const event of rawEvents) {
      if (event.entity_kind === "contact") {
        projectContactObservation(tx, sourceContactMap, deterministicHandleMap, event);
        continue;
      }

      if (event.entity_kind === "conversation") {
        projectConversationObservation(tx, sourceContactMap, conversationMap, event);
        continue;
      }

      if (event.entity_kind === "message") {
        projectMessageEvent(tx, sourceContactMap, conversationMap, event);
        continue;
      }

      if (event.entity_kind === "reaction") {
        projectReactionEvent(tx, sourceContactMap, conversationMap, event);
      }
    }

    refreshConversationDisplayNames(tx);
    reindexMessagesFts(tx);
  });

  const overview = db.getOverview();
  return {
    contacts: overview.contacts,
    conversations: overview.conversations,
    messages: overview.messages,
    rawEvents: overview.rawEvents,
  };
}

function projectContactObservation(
  conn: LocalDbExecutor,
  sourceContactMap: Map<string, string>,
  deterministicHandleMap: Map<string, string>,
  event: {
    id: string;
    platform: Platform;
    account_key: string;
    observed_at: number;
    payload_json: string;
  },
): void {
  const payload = JSON.parse(event.payload_json) as ContactObservationPayload;
  const sourceKey = `${event.platform}:${event.account_key}:${payload.sourceEntityKey}`;

  const deterministicHandles = payload.handles
    .filter((handle) => handle.deterministic)
    .map((handle) => ({
      ...handle,
      normalizedValue: normalizeHandle(handle.type, handle.value),
    }))
    .sort((left, right) => `${left.type}:${left.normalizedValue}`.localeCompare(`${right.type}:${right.normalizedValue}`));

  const existingContactId = deterministicHandles
    .map((handle) => deterministicHandleMap.get(`${handle.type}:${handle.normalizedValue}`) ?? null)
    .find((contactId): contactId is string => Boolean(contactId));

  const preferredIdentity = deterministicHandles[0]
    ? `${deterministicHandles[0].type}:${deterministicHandles[0].normalizedValue}`
    : sourceKey;

  const contactId = existingContactId ?? hashId("contact", preferredIdentity);
  sourceContactMap.set(sourceKey, contactId);
  for (const handle of deterministicHandles) {
    deterministicHandleMap.set(`${handle.type}:${handle.normalizedValue}`, contactId);
  }

  conn.insert(contacts).values({
    id: contactId,
    kind: "person",
    preferredDisplayName: payload.fields.display_name ?? null,
    preferredPhotoUrl: payload.fields.photo_url ?? null,
    preferredCompany: payload.fields.company ?? null,
    archived: 0,
    createdAt: event.observed_at,
    updatedAt: event.observed_at,
  }).onConflictDoNothing().run();

  const contactObservationValues = {
    id: hashId("contact_obs", `${contactId}:${event.id}`),
    platform: event.platform,
    accountKey: event.account_key,
    sourceEntityKey: payload.sourceEntityKey,
    observedAt: event.observed_at,
    fieldsJson: JSON.stringify(payload.fields),
    handlesJson: JSON.stringify(payload.handles),
    rawEventId: event.id,
  };

  conn.insert(contactObservations).values(contactObservationValues).onConflictDoUpdate({
    target: contactObservations.id,
    set: {
      platform: contactObservationValues.platform,
      accountKey: contactObservationValues.accountKey,
      sourceEntityKey: contactObservationValues.sourceEntityKey,
      observedAt: contactObservationValues.observedAt,
      fieldsJson: contactObservationValues.fieldsJson,
      handlesJson: contactObservationValues.handlesJson,
      rawEventId: contactObservationValues.rawEventId,
    },
  }).run();

  const contactSourceValues = {
    id: hashId("contact_source", sourceKey),
    contactId,
    platform: event.platform,
    accountKey: event.account_key,
    sourceEntityKey: payload.sourceEntityKey,
    sourceProfileUrl: null,
    firstSeenAt: event.observed_at,
    lastSeenAt: event.observed_at,
    metadataJson: null,
  };

  conn.insert(contactSources).values(contactSourceValues).onConflictDoUpdate({
    target: contactSources.id,
    set: {
      contactId: contactSourceValues.contactId,
      platform: contactSourceValues.platform,
      accountKey: contactSourceValues.accountKey,
      sourceEntityKey: contactSourceValues.sourceEntityKey,
      sourceProfileUrl: contactSourceValues.sourceProfileUrl,
      firstSeenAt: contactSourceValues.firstSeenAt,
      lastSeenAt: contactSourceValues.lastSeenAt,
      metadataJson: contactSourceValues.metadataJson,
    },
  }).run();

  for (const handle of payload.handles) {
    const normalizedValue = normalizeHandle(handle.type, handle.value);
    const contactHandleValues = {
      id: hashId("handle", `${contactId}:${handle.type}:${normalizedValue}`),
      contactId,
      handleType: handle.type,
      value: handle.value,
      normalizedValue,
      platformScope: event.platform,
      accountScope: event.account_key,
      isDeterministicKey: handle.deterministic ? 1 : 0,
      createdAt: event.observed_at,
      updatedAt: event.observed_at,
    };

    conn.insert(contactHandles).values(contactHandleValues).onConflictDoUpdate({
      target: contactHandles.id,
      set: {
        contactId: contactHandleValues.contactId,
        handleType: contactHandleValues.handleType,
        value: contactHandleValues.value,
        normalizedValue: contactHandleValues.normalizedValue,
        platformScope: contactHandleValues.platformScope,
        accountScope: contactHandleValues.accountScope,
        isDeterministicKey: contactHandleValues.isDeterministicKey,
        createdAt: contactHandleValues.createdAt,
        updatedAt: contactHandleValues.updatedAt,
      },
    }).run();
  }

  for (const [fieldName, fieldValue] of Object.entries(payload.fields)) {
    if (!fieldValue || !isContactFieldName(fieldName)) continue;
    const priority = fieldPriority(event.platform, fieldName);
    const current = currentBestPriority(conn, contactId, fieldName);
    const shouldWin =
      !current
      || priority > current.priority
      || (priority === current.priority && event.observed_at >= current.observedAt);

    if (shouldWin) {
      conn.update(contactFieldValues)
        .set({ isCurrentBest: 0 })
        .where(and(
          eq(contactFieldValues.contactId, contactId),
          eq(contactFieldValues.fieldName, fieldName),
        ))
        .run();
    }

    const contactFieldValue = {
      id: hashId("field", `${contactId}:${fieldName}:${event.platform}:${payload.sourceEntityKey}`),
      contactId,
      fieldName,
      fieldValue,
      platform: event.platform,
      accountKey: event.account_key,
      sourceEntityKey: payload.sourceEntityKey,
      priority,
      observedAt: event.observed_at,
      isCurrentBest: shouldWin ? 1 : 0,
    };

    conn.insert(contactFieldValues).values(contactFieldValue).onConflictDoUpdate({
      target: contactFieldValues.id,
      set: {
        contactId: contactFieldValue.contactId,
        fieldName: contactFieldValue.fieldName,
        fieldValue: contactFieldValue.fieldValue,
        platform: contactFieldValue.platform,
        accountKey: contactFieldValue.accountKey,
        sourceEntityKey: contactFieldValue.sourceEntityKey,
        priority: contactFieldValue.priority,
        observedAt: contactFieldValue.observedAt,
        isCurrentBest: contactFieldValue.isCurrentBest,
      },
    }).run();

    if (shouldWin && fieldName === "display_name") {
      conn.update(contacts)
        .set({
          preferredDisplayName: fieldValue,
          updatedAt: event.observed_at,
        })
        .where(eq(contacts.id, contactId))
        .run();
    } else if (shouldWin && fieldName === "photo_url") {
      conn.update(contacts)
        .set({
          preferredPhotoUrl: fieldValue,
          updatedAt: event.observed_at,
        })
        .where(eq(contacts.id, contactId))
        .run();
    } else if (shouldWin && fieldName === "company") {
      conn.update(contacts)
        .set({
          preferredCompany: fieldValue,
          updatedAt: event.observed_at,
        })
        .where(eq(contacts.id, contactId))
        .run();
    }
  }
}

function projectConversationObservation(
  conn: LocalDbExecutor,
  sourceContactMap: Map<string, string>,
  conversationMap: Map<string, string>,
  event: {
    id: string;
    platform: Platform;
    account_key: string;
    observed_at: number;
    payload_json: string;
  },
): void {
  const payload = JSON.parse(event.payload_json) as ConversationObservationPayload;
  const conversationId = hashId("conversation", `${event.platform}:${event.account_key}:${payload.sourceConversationKey}`);
  conversationMap.set(`${event.platform}:${event.account_key}:${payload.sourceConversationKey}`, conversationId);

  const conversationObservationValues = {
    id: hashId("conversation_obs", `${conversationId}:${event.id}`),
    platform: event.platform,
    accountKey: event.account_key,
    sourceConversationKey: payload.sourceConversationKey,
    observedAt: event.observed_at,
    fieldsJson: JSON.stringify({
      conversation_type: payload.conversationType,
      display_name: payload.displayName ?? null,
    }),
    rawEventId: event.id,
  };

  conn.insert(conversationObservations).values(conversationObservationValues).onConflictDoUpdate({
    target: conversationObservations.id,
    set: {
      platform: conversationObservationValues.platform,
      accountKey: conversationObservationValues.accountKey,
      sourceConversationKey: conversationObservationValues.sourceConversationKey,
      observedAt: conversationObservationValues.observedAt,
      fieldsJson: conversationObservationValues.fieldsJson,
      rawEventId: conversationObservationValues.rawEventId,
    },
  }).run();

  const conversationValues = {
    id: conversationId,
    platform: event.platform,
    accountKey: event.account_key,
    sourceConversationKey: payload.sourceConversationKey,
    conversationType: payload.conversationType,
    displayName: payload.displayName ?? null,
    topic: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    createdAt: event.observed_at,
    updatedAt: event.observed_at,
  };

  conn.insert(conversations).values(conversationValues).onConflictDoUpdate({
    target: conversations.id,
    set: {
      platform: conversationValues.platform,
      accountKey: conversationValues.accountKey,
      sourceConversationKey: conversationValues.sourceConversationKey,
      conversationType: conversationValues.conversationType,
      displayName: conversationValues.displayName,
      topic: conversationValues.topic,
      lastMessageAt: conversationValues.lastMessageAt,
      lastMessagePreview: conversationValues.lastMessagePreview,
      unreadCount: conversationValues.unreadCount,
      createdAt: conversationValues.createdAt,
      updatedAt: conversationValues.updatedAt,
    },
  }).run();

  for (const participant of payload.participants) {
    const contactId = sourceContactMap.get(`${event.platform}:${event.account_key}:${participant.sourceEntityKey}`)
      ?? sourceContactMap.get(`contacts:local:${participant.sourceEntityKey}`)
      ?? hashId("contact", participant.sourceEntityKey);

    const participantValues = {
      conversationId,
      contactId,
      role: null,
      joinedAt: event.observed_at,
      leftAt: null,
      isActive: 1,
      sourceParticipantKey: participant.sourceEntityKey,
      updatedAt: event.observed_at,
    };

    conn.insert(conversationParticipants).values(participantValues).onConflictDoUpdate({
      target: [
        conversationParticipants.conversationId,
        conversationParticipants.contactId,
        conversationParticipants.sourceParticipantKey,
      ],
      set: {
        role: participantValues.role,
        joinedAt: participantValues.joinedAt,
        leftAt: participantValues.leftAt,
        isActive: participantValues.isActive,
        updatedAt: participantValues.updatedAt,
      },
    }).run();
  }
}

function projectMessageEvent(
  conn: LocalDbExecutor,
  sourceContactMap: Map<string, string>,
  conversationMap: Map<string, string>,
  event: {
    id: string;
    platform: Platform;
    account_key: string;
    event_kind: string;
    observed_at: number;
    payload_json: string;
  },
): void {
  const payload = JSON.parse(event.payload_json) as MessagePayload;
  const messageId = hashId("message", `${event.platform}:${event.account_key}:${payload.sourceMessageKey}`);
  const conversationId = conversationMap.get(`${event.platform}:${event.account_key}:${payload.sourceConversationKey}`)
    ?? hashId("conversation", `${event.platform}:${event.account_key}:${payload.sourceConversationKey}`);
  const senderContactId = sourceContactMap.get(`${event.platform}:${event.account_key}:${payload.senderSourceKey}`)
    ?? (payload.senderSourceKey
      ? sourceContactMap.get(`contacts:local:${payload.senderSourceKey}`) ?? null
      : null);

  const messageEventValues = {
    id: hashId("message_event", `${messageId}:${event.id}`),
    platform: event.platform,
    accountKey: event.account_key,
    sourceMessageKey: payload.sourceMessageKey,
    sourceConversationKey: payload.sourceConversationKey,
    eventType: event.event_kind,
    eventAt: payload.sentAt,
    senderSourceKey: payload.senderSourceKey,
    contentOriginal: payload.contentOriginal,
    contentCurrent: payload.contentCurrent ?? payload.contentOriginal,
    statusDelivery: payload.statusDelivery ?? null,
    deleted: payload.isDeleted ? 1 : 0,
    edited: payload.isEdited ? 1 : 0,
    metadataJson: JSON.stringify({
      attachments: payload.attachments ?? [],
    }),
    rawEventId: event.id,
  };

  conn.insert(messageEvents).values(messageEventValues).onConflictDoUpdate({
    target: messageEvents.id,
    set: {
      platform: messageEventValues.platform,
      accountKey: messageEventValues.accountKey,
      sourceMessageKey: messageEventValues.sourceMessageKey,
      sourceConversationKey: messageEventValues.sourceConversationKey,
      eventType: messageEventValues.eventType,
      eventAt: messageEventValues.eventAt,
      senderSourceKey: messageEventValues.senderSourceKey,
      contentOriginal: messageEventValues.contentOriginal,
      contentCurrent: messageEventValues.contentCurrent,
      statusDelivery: messageEventValues.statusDelivery,
      deleted: messageEventValues.deleted,
      edited: messageEventValues.edited,
      metadataJson: messageEventValues.metadataJson,
      rawEventId: messageEventValues.rawEventId,
    },
  }).run();

  const messageValues = {
    id: messageId,
    platform: event.platform,
    accountKey: event.account_key,
    sourceMessageKey: payload.sourceMessageKey,
    conversationId,
    senderContactId: senderContactId ?? null,
    senderSourceKey: payload.senderSourceKey,
    sentAt: payload.sentAt,
    contentOriginal: payload.contentOriginal,
    contentCurrent: payload.contentCurrent ?? payload.contentOriginal,
    statusDelivery: payload.statusDelivery ?? null,
    deliveredAt: payload.deliveredAt ?? null,
    readAt: payload.readAt ?? null,
    editedAt: payload.editedAt ?? null,
    deletedAt: payload.deletedAt ?? null,
    isDeleted: payload.isDeleted ? 1 : 0,
    isEdited: payload.isEdited ? 1 : 0,
    hasAttachments: payload.hasAttachments ? 1 : 0,
    attachmentMetadataJson: payload.attachments ? JSON.stringify(payload.attachments) : null,
    reactionCount: 0,
    createdAt: event.observed_at,
    updatedAt: event.observed_at,
  };

  conn.insert(messages).values(messageValues).onConflictDoUpdate({
    target: messages.id,
    set: {
      platform: messageValues.platform,
      accountKey: messageValues.accountKey,
      sourceMessageKey: messageValues.sourceMessageKey,
      conversationId: messageValues.conversationId,
      senderContactId: messageValues.senderContactId,
      senderSourceKey: messageValues.senderSourceKey,
      sentAt: messageValues.sentAt,
      contentOriginal: messageValues.contentOriginal,
      contentCurrent: messageValues.contentCurrent,
      statusDelivery: messageValues.statusDelivery,
      deliveredAt: messageValues.deliveredAt,
      readAt: messageValues.readAt,
      editedAt: messageValues.editedAt,
      deletedAt: messageValues.deletedAt,
      isDeleted: messageValues.isDeleted,
      isEdited: messageValues.isEdited,
      hasAttachments: messageValues.hasAttachments,
      attachmentMetadataJson: messageValues.attachmentMetadataJson,
      reactionCount: messageValues.reactionCount,
      createdAt: messageValues.createdAt,
      updatedAt: messageValues.updatedAt,
    },
  }).run();

  conn.update(conversations)
    .set({
      lastMessageAt: payload.sentAt,
      lastMessagePreview: payload.contentCurrent ?? payload.contentOriginal,
      updatedAt: event.observed_at,
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

function projectReactionEvent(
  conn: LocalDbExecutor,
  sourceContactMap: Map<string, string>,
  conversationMap: Map<string, string>,
  event: {
    id: string;
    platform: Platform;
    account_key: string;
    observed_at: number;
    payload_json: string;
  },
): void {
  const payload = JSON.parse(event.payload_json) as ReactionPayload;
  const messageId = hashId("message", `${event.platform}:${event.account_key}:${payload.sourceMessageKey}`);
  const conversationId = conversationMap.get(`${event.platform}:${event.account_key}:${payload.sourceConversationKey}`)
    ?? hashId("conversation", `${event.platform}:${event.account_key}:${payload.sourceConversationKey}`);
  const reactorContactId = payload.reactorSourceKey
    ? sourceContactMap.get(`${event.platform}:${event.account_key}:${payload.reactorSourceKey}`)
      ?? sourceContactMap.get(`contacts:local:${payload.reactorSourceKey}`)
      ?? null
    : null;

  const reactionValues = {
    id: hashId("reaction", `${messageId}:${payload.reactorSourceKey ?? "__me__"}:${payload.emoji}`),
    messageId,
    platform: event.platform,
    sourceReactionKey: `${payload.sourceMessageKey}:${payload.reactorSourceKey ?? "__me__"}:${payload.emoji}`,
    emoji: payload.emoji,
    reactorContactId,
    reactorSourceKey: payload.reactorSourceKey,
    isActive: payload.isActive ? 1 : 0,
    createdAt: payload.timestamp,
    updatedAt: event.observed_at,
    rawEventId: event.id,
  };

  conn.insert(messageReactions).values(reactionValues).onConflictDoUpdate({
    target: messageReactions.id,
    set: {
      messageId: reactionValues.messageId,
      platform: reactionValues.platform,
      sourceReactionKey: reactionValues.sourceReactionKey,
      emoji: reactionValues.emoji,
      reactorContactId: reactionValues.reactorContactId,
      reactorSourceKey: reactionValues.reactorSourceKey,
      isActive: reactionValues.isActive,
      createdAt: reactionValues.createdAt,
      updatedAt: reactionValues.updatedAt,
      rawEventId: reactionValues.rawEventId,
    },
  }).run();

  const row = conn
    .select({
      count: sql<number>`count(*)`,
    })
    .from(messageReactions)
    .where(and(
      eq(messageReactions.messageId, messageId),
      eq(messageReactions.isActive, 1),
    ))
    .get();

  conn.update(messages)
    .set({
      reactionCount: Number(row?.count ?? 0),
      updatedAt: event.observed_at,
    })
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .run();
}

function reindexMessagesFts(conn: LocalDbExecutor): void {
  conn.run(sql.raw("DELETE FROM messages_fts"));

  const indexedMessages = conn.all<{
    id: string;
    platform: string;
    content_current: string | null;
    conversation_name: string | null;
    sender_name: string | null;
    participant_names: string | null;
  }>(sql`
    SELECT
      m.id,
      m.platform,
      m.content_current,
      conv.display_name AS conversation_name,
      sender.preferred_display_name AS sender_name,
      (
        SELECT GROUP_CONCAT(c.preferred_display_name, ' | ')
        FROM conversation_participants cp
        JOIN contacts c ON c.id = cp.contact_id
        WHERE cp.conversation_id = conv.id
          AND cp.is_active = 1
      ) AS participant_names
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    LEFT JOIN contacts sender ON sender.id = m.sender_contact_id
  `);

  for (const message of indexedMessages) {
    conn.run(sql`
      INSERT INTO messages_fts (
        message_id,
        platform,
        sender_name,
        conversation_name,
        participant_names,
        content
      ) VALUES (
        ${message.id},
        ${message.platform},
        ${message.sender_name ?? null},
        ${message.conversation_name ?? null},
        ${message.participant_names ?? null},
        ${message.content_current ?? ""}
      )
    `);
  }
}

function refreshConversationDisplayNames(conn: LocalDbExecutor): void {
  conn.run(sql`
    UPDATE conversations
    SET display_name = (
      SELECT
        CASE
          WHEN COUNT(*) = 1 THEN MAX(c.preferred_display_name)
          ELSE GROUP_CONCAT(c.preferred_display_name, ' | ')
        END
      FROM conversation_participants cp
      JOIN contacts c ON c.id = cp.contact_id
      WHERE cp.conversation_id = conversations.id
        AND cp.is_active = 1
    )
    WHERE (display_name IS NULL OR display_name = '' OR display_name = source_conversation_key)
      AND conversation_type = 'dm'
  `);
}

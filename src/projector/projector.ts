import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { CuedDatabase, LocalDrizzleDatabase } from "../db/database.js";
import {
  contactHandles,
  contactSources,
  contacts,
  conversationParticipants,
  conversations,
  messageAttachments,
  messageReactions,
  messages,
  projectionState,
  timelineEvents,
} from "../db/schema.js";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  Platform,
  ReactionPayload,
  TimelineEventPayload,
} from "../types/provider.js";

type LocalDbExecutor = Pick<
  LocalDrizzleDatabase,
  "all" | "delete" | "get" | "insert" | "run" | "select" | "update"
>;

type RawEventRow = {
  rowid: number;
  id: string;
  platform: Platform;
  account_key: string;
  entity_kind: string;
  event_kind: string;
  observed_at: number;
  payload_json: string;
};

type ProjectionMode = "realtime" | "deferred" | "rebuild";

type ProjectionCache = {
  initialized: boolean;
  sourceContactMap: Map<string, string>;
  deterministicHandleMap: Map<string, string>;
  conversationMap: Map<string, string>;
  contactNameMap: Map<string, string | null>;
  conversationNameMap: Map<string, string | null>;
};

type ProjectionChangeSet = {
  dirtyContactIds: Set<string>;
  dirtyConversationIds: Set<string>;
  dirtyMessageIds: Set<string>;
  dirtyReplyMessageIds: Set<string>;
};

type ProjectableRawEvent = Pick<
  RawEventRow,
  "platform" | "account_key" | "event_kind" | "observed_at" | "payload_json"
>;

type ProjectionOverview = {
  contacts: number;
  conversations: number;
  messages: number;
  rawEvents: number;
  appliedRawEvents: number;
  projectionWatermark: number;
};

export type ProjectionRangeResult = ProjectionOverview & {
  completed: boolean;
  nextStartRowId: number | null;
  rangeStartRowId: number | null;
  rangeEndRowId: number | null;
};

const projectionCaches = new WeakMap<CuedDatabase, ProjectionCache>();
const SQL_CHUNK_SIZE = 200;

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

function inferHandleFromSourceEntityKey(
  sourceEntityKey: string | null | undefined,
): { type: string; normalizedValue: string } | null {
  if (!sourceEntityKey || !sourceEntityKey.startsWith("imessage:")) {
    return null;
  }

  const identifier = sourceEntityKey.slice("imessage:".length).trim();
  if (identifier.length === 0) {
    return null;
  }

  const type = identifier.includes("@") ? "email" : "phone";
  return {
    type,
    normalizedValue: normalizeHandle(type, identifier),
  };
}

function findProjectedContactIdBySourceKey(
  conn: LocalDbExecutor,
  sourceEntityKey: string,
): string | null {
  const messageRow = conn.get<{ contact_id: string }>(sql`
    SELECT sender_contact_id AS contact_id
    FROM messages
    WHERE sender_source_key = ${sourceEntityKey}
      AND sender_contact_id IS NOT NULL
    LIMIT 1
  `);
  if (messageRow?.contact_id) {
    return messageRow.contact_id;
  }

  const participantRow = conn.get<{ contact_id: string }>(sql`
    SELECT contact_id
    FROM conversation_participants
    WHERE source_participant_key = ${sourceEntityKey}
    LIMIT 1
  `);
  return participantRow?.contact_id ?? null;
}

function findProjectedContactIdByKnownHandleAliases(
  conn: LocalDbExecutor,
  deterministicHandles: Array<{ type: string; normalizedValue: string }>,
): string | null {
  for (const handle of deterministicHandles) {
    if (handle.type !== "phone" && handle.type !== "email") {
      continue;
    }

    const sourceEntityKey = `imessage:${handle.normalizedValue}`;
    const contactId = findProjectedContactIdBySourceKey(conn, sourceEntityKey);
    if (contactId) {
      return contactId;
    }
  }

  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

function hasStringValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeAttachmentObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function inferAttachmentProjection(attachment: Record<string, unknown>): {
  localPath: string | null;
  remoteUrl: string | null;
  accessKind: string | null;
  accessRefJson: string | null;
  previewRefJson: string | null;
  availabilityStatus: string | null;
  providerMetadataJson: string | null;
} {
  const localPath =
    normalizeText(attachment.local_path) ??
    normalizeText(attachment.path) ??
    normalizeText(attachment.filename_path);
  const remoteUrl =
    normalizeText(attachment.remote_url) ??
    normalizeText(attachment.url) ??
    normalizeText(attachment.download_url);
  const explicitAccessKind = normalizeText(attachment.access_kind);
  const explicitAccessRef = normalizeAttachmentObject(attachment.access_ref);
  const explicitPreviewRef = normalizeAttachmentObject(attachment.preview_ref);
  const providerFetchRef =
    normalizeAttachmentObject(attachment.provider_fetch) ??
    normalizeAttachmentObject(attachment.download_ref);

  const accessKind =
    explicitAccessKind ??
    (localPath
      ? "local_path"
      : providerFetchRef
        ? "provider_fetch"
        : remoteUrl
          ? "remote_url"
          : null);
  const accessRefJson =
    explicitAccessRef != null
      ? JSON.stringify(explicitAccessRef)
      : accessKind === "local_path" && localPath
        ? JSON.stringify({ path: localPath })
        : accessKind === "provider_fetch" && providerFetchRef
          ? JSON.stringify(providerFetchRef)
          : accessKind === "remote_url" && remoteUrl
            ? JSON.stringify({ url: remoteUrl })
            : null;
  const previewRefJson =
    explicitPreviewRef != null
      ? JSON.stringify(explicitPreviewRef)
      : (normalizeText(attachment.previewUrl) ??
          normalizeText(attachment.preview_url) ??
          normalizeText(attachment.thumb_url) ??
          normalizeText(attachment.image_url))
        ? JSON.stringify({
            url:
              normalizeText(attachment.previewUrl) ??
              normalizeText(attachment.preview_url) ??
              normalizeText(attachment.thumb_url) ??
              normalizeText(attachment.image_url),
          })
        : null;
  const availabilityStatus =
    normalizeText(attachment.availability_status) ?? (accessKind ? "available" : "metadata_only");
  const providerMetadata = normalizeAttachmentObject(attachment.provider_metadata);

  return {
    localPath,
    remoteUrl,
    accessKind,
    accessRefJson,
    previewRefJson,
    availabilityStatus,
    providerMetadataJson: JSON.stringify(providerMetadata ?? attachment),
  };
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sqlValueList(values: readonly (string | number)[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function createProjectionCache(): ProjectionCache {
  return {
    initialized: false,
    sourceContactMap: new Map<string, string>(),
    deterministicHandleMap: new Map<string, string>(),
    conversationMap: new Map<string, string>(),
    contactNameMap: new Map<string, string | null>(),
    conversationNameMap: new Map<string, string | null>(),
  };
}

function hydrateProjectionCache(db: CuedDatabase, cache: ProjectionCache): void {
  cache.sourceContactMap.clear();
  cache.deterministicHandleMap.clear();
  cache.conversationMap.clear();
  cache.contactNameMap.clear();
  cache.conversationNameMap.clear();

  for (const row of db.listProjectedContactSourceMap()) {
    cache.sourceContactMap.set(
      `${row.platform}:${row.account_key}:${row.source_entity_key}`,
      row.contact_id,
    );
  }

  for (const row of db.listDeterministicContactHandles()) {
    cache.deterministicHandleMap.set(`${row.handle_type}:${row.normalized_value}`, row.contact_id);
  }

  for (const row of db.listConversationMap()) {
    cache.conversationMap.set(
      `${row.platform}:${row.account_key}:${row.source_conversation_key}`,
      row.conversation_id,
    );
  }

  for (const row of db.listContactNames()) {
    cache.contactNameMap.set(row.contact_id, row.name);
  }

  for (const row of db.listConversationNames()) {
    cache.conversationNameMap.set(row.conversation_id, row.name);
  }

  cache.initialized = true;
}

function getProjectionCache(db: CuedDatabase): ProjectionCache {
  const existing = projectionCaches.get(db);
  if (existing) {
    if (!existing.initialized) {
      hydrateProjectionCache(db, existing);
    }
    return existing;
  }

  const created = createProjectionCache();
  hydrateProjectionCache(db, created);
  projectionCaches.set(db, created);
  return created;
}

function resetProjectionCache(db: CuedDatabase): ProjectionCache {
  const cache = createProjectionCache();
  cache.initialized = true;
  projectionCaches.set(db, cache);
  return cache;
}

function createProjectionChangeSet(): ProjectionChangeSet {
  return {
    dirtyContactIds: new Set<string>(),
    dirtyConversationIds: new Set<string>(),
    dirtyMessageIds: new Set<string>(),
    dirtyReplyMessageIds: new Set<string>(),
  };
}

function buildOverview(db: CuedDatabase): {
  contacts: number;
  conversations: number;
  messages: number;
  rawEvents: number;
} {
  const overview = db.getOverview();
  return {
    contacts: overview.contacts,
    conversations: overview.conversations,
    messages: overview.messages,
    rawEvents: overview.rawEvents,
  };
}

function syncContactNameCache(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  contactIds: Set<string>,
): void {
  for (const chunk of chunkArray([...contactIds], SQL_CHUNK_SIZE)) {
    const rows = conn.all<{ id: string; name: string | null }>(sql`
      SELECT id, name
      FROM contacts
      WHERE id IN (${sqlValueList(chunk)})
    `);
    for (const row of rows) {
      cache.contactNameMap.set(row.id, row.name);
    }
  }
}

function syncConversationNameCache(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  conversationIds: Set<string>,
): void {
  for (const chunk of chunkArray([...conversationIds], SQL_CHUNK_SIZE)) {
    const rows = conn.all<{ id: string; name: string | null }>(sql`
      SELECT id, name
      FROM conversations
      WHERE id IN (${sqlValueList(chunk)})
    `);
    for (const row of rows) {
      cache.conversationNameMap.set(row.id, row.name);
    }
  }
}

function ensureContactStub(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  platform: Platform,
  accountKey: string,
  sourceEntityKey: string | null | undefined,
  observedAt: number,
): string | null {
  if (!sourceEntityKey) {
    return null;
  }

  const sourceKey = `${platform}:${accountKey}:${sourceEntityKey}`;
  const existingContactId = cache.sourceContactMap.get(sourceKey);
  const contactId = existingContactId ?? hashId("contact", sourceKey);
  cache.sourceContactMap.set(sourceKey, contactId);
  if (!cache.contactNameMap.has(contactId)) {
    cache.contactNameMap.set(contactId, null);
  }

  conn
    .insert(contacts)
    .values({
      id: contactId,
      kind: "person",
      name: null,
      photoUrl: null,
      company: null,
      archived: 0,
      createdAt: observedAt,
      updatedAt: observedAt,
    })
    .onConflictDoNothing()
    .run();

  return contactId;
}

function resolveOrEnsureContact(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  platform: Platform,
  accountKey: string,
  sourceEntityKey: string | null | undefined,
  observedAt: number,
): string | null {
  if (!sourceEntityKey) {
    return null;
  }

  const directKey = `${platform}:${accountKey}:${sourceEntityKey}`;
  const contactsLocalKey = `contacts:local:${sourceEntityKey}`;
  const existingContactId =
    cache.sourceContactMap.get(directKey) ?? cache.sourceContactMap.get(contactsLocalKey) ?? null;
  if (existingContactId) {
    return existingContactId;
  }

  const inferredHandle = inferHandleFromSourceEntityKey(sourceEntityKey);
  if (inferredHandle) {
    const handleContactId =
      cache.deterministicHandleMap.get(
        `${inferredHandle.type}:${inferredHandle.normalizedValue}`,
      ) ?? null;
    if (handleContactId) {
      cache.sourceContactMap.set(directKey, handleContactId);
      return handleContactId;
    }
  }

  return ensureContactStub(conn, cache, platform, accountKey, sourceEntityKey, observedAt);
}

function ensureConversationStub(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  platform: Platform,
  accountKey: string,
  sourceConversationKey: string,
  observedAt: number,
): string {
  const mapKey = `${platform}:${accountKey}:${sourceConversationKey}`;
  const existingConversationId = cache.conversationMap.get(mapKey);
  const conversationId = existingConversationId ?? hashId("conversation", mapKey);
  cache.conversationMap.set(mapKey, conversationId);
  if (!cache.conversationNameMap.has(conversationId)) {
    cache.conversationNameMap.set(conversationId, null);
  }

  conn
    .insert(conversations)
    .values({
      id: conversationId,
      platform,
      accountKey,
      sourceConversationKey,
      nativeConversationKey: null,
      type: "dm",
      subtype: null,
      service: null,
      name: null,
      topic: null,
      participantNames: null,
      lastMessageId: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      unreadCount: 0,
      createdAt: observedAt,
      updatedAt: observedAt,
    })
    .onConflictDoNothing()
    .run();

  return conversationId;
}

function ensureMessageStub(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  platform: Platform,
  accountKey: string,
  sourceConversationKey: string,
  platformMessageId: string,
  observedAt: number,
): { messageId: string; conversationId: string } {
  const messageId = hashId("message", `${platform}:${accountKey}:${platformMessageId}`);
  const conversationId = ensureConversationStub(
    conn,
    cache,
    platform,
    accountKey,
    sourceConversationKey,
    observedAt,
  );

  conn
    .insert(messages)
    .values({
      id: messageId,
      platform,
      accountKey,
      platformMessageId,
      conversationId,
      senderContactId: null,
      senderSourceKey: null,
      senderName: null,
      conversationName: null,
      sentAt: observedAt,
      service: null,
      status: null,
      isFromMe: 0,
      content: null,
      deliveredAt: null,
      readAt: null,
      editedAt: null,
      deletedAt: null,
      replyToMessageId: null,
      isDeleted: 0,
      isEdited: 0,
      attachmentCount: 0,
      reactionCount: 0,
      createdAt: observedAt,
      updatedAt: observedAt,
    })
    .onConflictDoNothing()
    .run();

  return { messageId, conversationId };
}

function clearProjectedState(conn: LocalDbExecutor): void {
  conn.run(sql.raw("DELETE FROM messages_fts"));
  conn.delete(timelineEvents).run();
  conn.delete(messageAttachments).run();
  conn.delete(messageReactions).run();
  conn.delete(conversationParticipants).run();
  conn.delete(messages).run();
  conn.delete(conversations).run();
  conn.delete(contactHandles).run();
  conn.delete(contactSources).run();
  conn.delete(contacts).run();
}

function upsertProjectionState(
  conn: LocalDbExecutor,
  input: {
    projectionWatermark: number;
    lastProjectedAt: number | null;
    lastRebuildAt?: number | null;
  },
): void {
  conn
    .insert(projectionState)
    .values({
      singletonKey: "global",
      projectionWatermark: input.projectionWatermark,
      lastProjectedAt: input.lastProjectedAt,
      lastRebuildAt: input.lastRebuildAt ?? null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: projectionState.singletonKey,
      set: {
        projectionWatermark: sql`MAX(${projectionState.projectionWatermark}, ${input.projectionWatermark})`,
        lastProjectedAt: input.lastProjectedAt,
        lastRebuildAt: input.lastRebuildAt ?? sql`${projectionState.lastRebuildAt}`,
        updatedAt: Date.now(),
      },
    })
    .run();
}

function projectRealtimeConversationObservation(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as ConversationObservationPayload;
  const conversationId = ensureConversationStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    event.observed_at,
  );

  const conversationSet: {
    updatedAt: number;
    nativeConversationKey?: string | null;
    type: "dm" | "group";
    subtype?: string | null;
    service?: string | null;
    name?: string | null;
    topic?: string | null;
    unreadCount?: number;
  } = {
    updatedAt: event.observed_at,
    type: payload.conversationType,
  };
  if (payload.nativeConversationKey !== undefined) {
    conversationSet.nativeConversationKey = normalizeText(payload.nativeConversationKey);
  }
  if (payload.subtype !== undefined) {
    conversationSet.subtype = normalizeText(payload.subtype);
  }
  if (payload.service !== undefined) {
    conversationSet.service = normalizeText(payload.service);
  }
  if (payload.displayName !== undefined) {
    conversationSet.name = normalizeText(payload.displayName);
  }
  if (payload.topic !== undefined) {
    conversationSet.topic = normalizeText(payload.topic);
  }
  if (payload.unreadCount !== undefined && payload.unreadCount !== null) {
    conversationSet.unreadCount = payload.unreadCount;
  }

  conn.update(conversations).set(conversationSet).where(eq(conversations.id, conversationId)).run();

  if (event.event_kind === "removed") {
    conn
      .update(conversationParticipants)
      .set({
        isActive: 0,
        leftAt: event.observed_at,
        updatedAt: event.observed_at,
      })
      .where(eq(conversationParticipants.conversationId, conversationId))
      .run();
  }

  if (event.event_kind === "removed") {
    for (const participant of payload.participants) {
      const contactId = resolveOrEnsureContact(
        conn,
        cache,
        event.platform,
        event.account_key,
        participant.sourceEntityKey,
        event.observed_at,
      );
      if (!contactId) {
        continue;
      }

      conn
        .insert(conversationParticipants)
        .values({
          conversationId,
          contactId,
          sourceParticipantKey: participant.sourceEntityKey,
          participantName: cache.contactNameMap.get(contactId) ?? null,
          role: null,
          isSelf: boolToInt(participant.isSelf),
          isActive: 0,
          joinedAt: event.observed_at,
          leftAt: event.observed_at,
          updatedAt: event.observed_at,
        })
        .onConflictDoUpdate({
          target: [
            conversationParticipants.conversationId,
            conversationParticipants.contactId,
            conversationParticipants.sourceParticipantKey,
          ],
          set: {
            participantName: cache.contactNameMap.get(contactId) ?? null,
            isSelf: boolToInt(participant.isSelf),
            isActive: 0,
            leftAt: event.observed_at,
            updatedAt: event.observed_at,
          },
        })
        .run();
    }
  }

  if (payload.displayName !== undefined) {
    cache.conversationNameMap.set(conversationId, normalizeText(payload.displayName));
  }
  changes.dirtyConversationIds.add(conversationId);
}

function projectRealtimeMessageEvent(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as MessagePayload;
  const { messageId, conversationId } = ensureMessageStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    payload.sourceMessageKey,
    event.observed_at,
  );

  conn
    .update(messages)
    .set({
      platform: event.platform,
      accountKey: event.account_key,
      platformMessageId: payload.sourceMessageKey,
      conversationId,
      senderContactId: null,
      senderSourceKey: payload.senderSourceKey,
      senderName: null,
      conversationName: cache.conversationNameMap.get(conversationId) ?? null,
      sentAt: payload.sentAt,
      service: normalizeText(payload.service ?? null),
      status: normalizeText(payload.status ?? null),
      isFromMe: boolToInt(payload.isFromMe),
      content: normalizeText(payload.content) ?? payload.content,
      deliveredAt: payload.deliveredAt ?? null,
      readAt: payload.readAt ?? null,
      editedAt: payload.editedAt ?? null,
      deletedAt: payload.deletedAt ?? null,
      isDeleted: boolToInt(payload.isDeleted),
      isEdited: boolToInt(payload.isEdited),
      updatedAt: event.observed_at,
    })
    .where(eq(messages.id, messageId))
    .run();

  changes.dirtyConversationIds.add(conversationId);
  changes.dirtyMessageIds.add(messageId);
}

function projectContactObservation(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as ContactObservationPayload;
  const sourceKey = `${event.platform}:${event.account_key}:${payload.sourceEntityKey}`;

  const deterministicHandles = payload.handles
    .filter((handle) => handle.deterministic)
    .map((handle) => ({
      ...handle,
      normalizedValue: normalizeHandle(handle.type, handle.value),
    }))
    .sort((left, right) =>
      `${left.type}:${left.normalizedValue}`.localeCompare(
        `${right.type}:${right.normalizedValue}`,
      ),
    );

  const existingSourceContactId = cache.sourceContactMap.get(sourceKey) ?? null;
  const existingContactId = deterministicHandles
    .map(
      (handle) =>
        cache.deterministicHandleMap.get(`${handle.type}:${handle.normalizedValue}`) ?? null,
    )
    .find((contactId): contactId is string => Boolean(contactId));
  const existingAliasedContactId =
    existingContactId == null
      ? findProjectedContactIdByKnownHandleAliases(conn, deterministicHandles)
      : null;

  const preferredIdentity = deterministicHandles[0]
    ? `${deterministicHandles[0].type}:${deterministicHandles[0].normalizedValue}`
    : sourceKey;

  const contactId =
    existingSourceContactId ??
    existingContactId ??
    existingAliasedContactId ??
    hashId("contact", preferredIdentity);
  cache.sourceContactMap.set(sourceKey, contactId);
  for (const handle of deterministicHandles) {
    cache.deterministicHandleMap.set(`${handle.type}:${handle.normalizedValue}`, contactId);
  }

  conn
    .insert(contacts)
    .values({
      id: contactId,
      kind: "person",
      name: normalizeText(payload.fields.display_name) ?? null,
      photoUrl: normalizeText(payload.fields.photo_url) ?? null,
      company: normalizeText(payload.fields.company) ?? null,
      archived: 0,
      createdAt: event.observed_at,
      updatedAt: event.observed_at,
    })
    .onConflictDoNothing()
    .run();

  const contactSet: {
    updatedAt: number;
    name?: string | null;
    photoUrl?: string | null;
    company?: string | null;
  } = {
    updatedAt: event.observed_at,
  };
  if (payload.fields.display_name !== undefined) {
    contactSet.name = normalizeText(payload.fields.display_name);
  }
  if (payload.fields.photo_url !== undefined) {
    contactSet.photoUrl = normalizeText(payload.fields.photo_url);
  }
  if (payload.fields.company !== undefined) {
    contactSet.company = normalizeText(payload.fields.company);
  }

  const resolvedName =
    payload.fields.display_name !== undefined
      ? normalizeText(payload.fields.display_name)
      : (cache.contactNameMap.get(contactId) ?? null);
  cache.contactNameMap.set(contactId, resolvedName);

  conn.update(contacts).set(contactSet).where(eq(contacts.id, contactId)).run();

  conn
    .insert(contactSources)
    .values({
      id: hashId("contact_source", sourceKey),
      contactId,
      platform: event.platform,
      accountKey: event.account_key,
      sourceEntityKey: payload.sourceEntityKey,
      profileUrl: normalizeText(payload.sourceProfileUrl ?? null),
      metadataJson: null,
      firstSeenAt: event.observed_at,
      lastSeenAt: event.observed_at,
    })
    .onConflictDoUpdate({
      target: contactSources.id,
      set: {
        contactId,
        profileUrl: normalizeText(payload.sourceProfileUrl ?? null),
        metadataJson: null,
        lastSeenAt: event.observed_at,
      },
    })
    .run();

  for (const handle of payload.handles) {
    const normalizedValue = normalizeHandle(handle.type, handle.value);
    conn
      .insert(contactHandles)
      .values({
        id: hashId("handle", `${contactId}:${handle.type}:${normalizedValue}`),
        contactId,
        type: handle.type,
        value: handle.value,
        normalizedValue,
        platform: event.platform,
        accountKey: event.account_key,
        isDeterministic: handle.deterministic ? 1 : 0,
        createdAt: event.observed_at,
        updatedAt: event.observed_at,
      })
      .onConflictDoUpdate({
        target: contactHandles.id,
        set: {
          value: handle.value,
          platform: event.platform,
          accountKey: event.account_key,
          isDeterministic: handle.deterministic ? 1 : 0,
          updatedAt: event.observed_at,
        },
      })
      .run();
  }

  changes.dirtyContactIds.add(contactId);
}

function projectConversationObservation(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as ConversationObservationPayload;
  const conversationId = ensureConversationStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    event.observed_at,
  );

  const conversationSet: {
    updatedAt: number;
    nativeConversationKey?: string | null;
    type: "dm" | "group";
    subtype?: string | null;
    service?: string | null;
    name?: string | null;
    topic?: string | null;
    unreadCount?: number;
  } = {
    updatedAt: event.observed_at,
    type: payload.conversationType,
  };
  if (payload.nativeConversationKey !== undefined) {
    conversationSet.nativeConversationKey = normalizeText(payload.nativeConversationKey);
  }
  if (payload.subtype !== undefined) {
    conversationSet.subtype = normalizeText(payload.subtype);
  }
  if (payload.service !== undefined) {
    conversationSet.service = normalizeText(payload.service);
  }
  if (payload.displayName !== undefined) {
    conversationSet.name = normalizeText(payload.displayName);
  }
  if (payload.topic !== undefined) {
    conversationSet.topic = normalizeText(payload.topic);
  }
  if (payload.unreadCount !== undefined && payload.unreadCount !== null) {
    conversationSet.unreadCount = payload.unreadCount;
  }

  conn.update(conversations).set(conversationSet).where(eq(conversations.id, conversationId)).run();

  const resolvedName =
    payload.displayName !== undefined
      ? normalizeText(payload.displayName)
      : (cache.conversationNameMap.get(conversationId) ?? null);
  cache.conversationNameMap.set(conversationId, resolvedName);

  if (event.event_kind === "removed") {
    conn
      .update(conversationParticipants)
      .set({
        isActive: 0,
        leftAt: event.observed_at,
        updatedAt: event.observed_at,
      })
      .where(eq(conversationParticipants.conversationId, conversationId))
      .run();
  }

  for (const participant of payload.participants) {
    const contactId = resolveOrEnsureContact(
      conn,
      cache,
      event.platform,
      event.account_key,
      participant.sourceEntityKey,
      event.observed_at,
    );
    if (!contactId) {
      continue;
    }

    conn
      .insert(conversationParticipants)
      .values({
        conversationId,
        contactId,
        sourceParticipantKey: participant.sourceEntityKey,
        participantName: cache.contactNameMap.get(contactId) ?? null,
        role: null,
        isSelf: boolToInt(participant.isSelf),
        isActive: event.event_kind === "removed" ? 0 : 1,
        joinedAt: event.observed_at,
        leftAt: event.event_kind === "removed" ? event.observed_at : null,
        updatedAt: event.observed_at,
      })
      .onConflictDoUpdate({
        target: [
          conversationParticipants.conversationId,
          conversationParticipants.contactId,
          conversationParticipants.sourceParticipantKey,
        ],
        set: {
          participantName: cache.contactNameMap.get(contactId) ?? null,
          isSelf: boolToInt(participant.isSelf),
          isActive: event.event_kind === "removed" ? 0 : 1,
          leftAt: event.event_kind === "removed" ? event.observed_at : null,
          updatedAt: event.observed_at,
        },
      })
      .run();
  }

  changes.dirtyConversationIds.add(conversationId);
}

function projectMessageEvent(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as MessagePayload;
  const { messageId, conversationId } = ensureMessageStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    payload.sourceMessageKey,
    event.observed_at,
  );

  const senderContactId = resolveOrEnsureContact(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.senderSourceKey,
    event.observed_at,
  );

  conn
    .update(messages)
    .set({
      platform: event.platform,
      accountKey: event.account_key,
      platformMessageId: payload.sourceMessageKey,
      conversationId,
      senderContactId: senderContactId ?? null,
      senderSourceKey: payload.senderSourceKey,
      senderName: senderContactId ? (cache.contactNameMap.get(senderContactId) ?? null) : null,
      conversationName: cache.conversationNameMap.get(conversationId) ?? null,
      sentAt: payload.sentAt,
      service: normalizeText(payload.service ?? null),
      status: normalizeText(payload.status ?? null),
      isFromMe: boolToInt(payload.isFromMe),
      content: normalizeText(payload.content) ?? payload.content,
      deliveredAt: payload.deliveredAt ?? null,
      readAt: payload.readAt ?? null,
      editedAt: payload.editedAt ?? null,
      deletedAt: payload.deletedAt ?? null,
      isDeleted: boolToInt(payload.isDeleted),
      isEdited: boolToInt(payload.isEdited),
      updatedAt: event.observed_at,
    })
    .where(eq(messages.id, messageId))
    .run();

  changes.dirtyConversationIds.add(conversationId);
  changes.dirtyMessageIds.add(messageId);
  if (hasStringValue(payload.replyToSourceMessageKey)) {
    changes.dirtyReplyMessageIds.add(messageId);
  }

  const desiredAttachmentIds = new Set<string>();
  for (const [index, attachment] of (payload.attachments ?? []).entries()) {
    const normalizedAttachment = normalizeAttachmentObject(attachment) ?? {};
    const explicitSourceAttachmentKey = normalizeText(normalizedAttachment.sourceAttachmentKey);
    const attachmentIdentity =
      explicitSourceAttachmentKey ??
      normalizeText(normalizedAttachment.id) ??
      normalizeText(normalizedAttachment.url) ??
      String(index);
    const sourceAttachmentKey =
      explicitSourceAttachmentKey ?? `${payload.sourceMessageKey}:${attachmentIdentity}`;
    const attachmentId = hashId("attachment", `${messageId}:${sourceAttachmentKey}`);
    desiredAttachmentIds.add(attachmentId);
    const inferred = inferAttachmentProjection(normalizedAttachment);

    conn
      .insert(messageAttachments)
      .values({
        id: attachmentId,
        messageId,
        platform: event.platform,
        accountKey: event.account_key,
        sourceAttachmentKey,
        kind: normalizeText(normalizedAttachment.kind),
        mimeType:
          normalizeText(normalizedAttachment.mime_type) ??
          normalizeText(normalizedAttachment.mimetype),
        filename:
          normalizeText(normalizedAttachment.filename) ?? normalizeText(normalizedAttachment.name),
        title: normalizeText(normalizedAttachment.title),
        localPath: inferred.localPath,
        remoteUrl: inferred.remoteUrl,
        sizeBytes:
          normalizeInteger(normalizedAttachment.size_bytes) ??
          normalizeInteger(normalizedAttachment.size),
        textContent:
          normalizeText(normalizedAttachment.text_content) ??
          normalizeText(normalizedAttachment.text),
        accessKind: inferred.accessKind,
        accessRefJson: inferred.accessRefJson,
        previewRefJson: inferred.previewRefJson,
        availabilityStatus: inferred.availabilityStatus,
        providerMetadataJson: inferred.providerMetadataJson,
        metadataJson: JSON.stringify(normalizedAttachment),
        createdAt: event.observed_at,
        updatedAt: event.observed_at,
      })
      .onConflictDoUpdate({
        target: messageAttachments.id,
        set: {
          kind: normalizeText(normalizedAttachment.kind),
          mimeType:
            normalizeText(normalizedAttachment.mime_type) ??
            normalizeText(normalizedAttachment.mimetype),
          filename:
            normalizeText(normalizedAttachment.filename) ??
            normalizeText(normalizedAttachment.name),
          title: normalizeText(normalizedAttachment.title),
          localPath: inferred.localPath,
          remoteUrl: inferred.remoteUrl,
          sizeBytes:
            normalizeInteger(normalizedAttachment.size_bytes) ??
            normalizeInteger(normalizedAttachment.size),
          textContent:
            normalizeText(normalizedAttachment.text_content) ??
            normalizeText(normalizedAttachment.text),
          accessKind: inferred.accessKind,
          accessRefJson: inferred.accessRefJson,
          previewRefJson: inferred.previewRefJson,
          availabilityStatus: inferred.availabilityStatus,
          providerMetadataJson: inferred.providerMetadataJson,
          metadataJson: JSON.stringify(normalizedAttachment),
          updatedAt: event.observed_at,
        },
      })
      .run();
  }

  const existingAttachments = conn.all<{ id: string }>(sql`
    SELECT id
    FROM message_attachments
    WHERE message_id = ${messageId}
  `);
  for (const existingAttachment of existingAttachments) {
    if (desiredAttachmentIds.has(existingAttachment.id)) {
      continue;
    }
    conn.run(sql`
      DELETE FROM attachment_content_fts
      WHERE attachment_id = ${existingAttachment.id}
    `);
    conn.delete(messageAttachments).where(eq(messageAttachments.id, existingAttachment.id)).run();
  }
}

function projectReactionEvent(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as ReactionPayload;
  const { messageId, conversationId } = ensureMessageStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    payload.sourceMessageKey,
    event.observed_at,
  );
  const reactorContactId = resolveOrEnsureContact(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.reactorSourceKey,
    event.observed_at,
  );

  conn
    .insert(messageReactions)
    .values({
      id: hashId(
        "reaction",
        `${messageId}:${payload.reactorSourceKey ?? "__me__"}:${payload.emoji}`,
      ),
      messageId,
      platform: event.platform,
      accountKey: event.account_key,
      sourceReactionKey: `${payload.sourceMessageKey}:${payload.reactorSourceKey ?? "__me__"}:${payload.emoji}`,
      reactorContactId,
      reactorSourceKey: payload.reactorSourceKey,
      reactorName: reactorContactId ? (cache.contactNameMap.get(reactorContactId) ?? null) : null,
      emoji: payload.emoji,
      reactionType: normalizeText(payload.reactionType ?? null),
      isActive: boolToInt(payload.isActive),
      createdAt: payload.timestamp,
      updatedAt: event.observed_at,
    })
    .onConflictDoUpdate({
      target: messageReactions.id,
      set: {
        reactorContactId,
        reactorSourceKey: payload.reactorSourceKey,
        reactorName: reactorContactId ? (cache.contactNameMap.get(reactorContactId) ?? null) : null,
        reactionType: normalizeText(payload.reactionType ?? null),
        isActive: boolToInt(payload.isActive),
        updatedAt: event.observed_at,
      },
    })
    .run();

  changes.dirtyConversationIds.add(conversationId);
  changes.dirtyMessageIds.add(messageId);
}

function projectTimelineEvent(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  event: ProjectableRawEvent,
): void {
  const payload = JSON.parse(event.payload_json) as TimelineEventPayload;
  const conversationId = ensureConversationStub(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.sourceConversationKey,
    event.observed_at,
  );
  const actorContactId = resolveOrEnsureContact(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.actorSourceKey,
    event.observed_at,
  );
  const subjectContactId = resolveOrEnsureContact(
    conn,
    cache,
    event.platform,
    event.account_key,
    payload.subjectSourceKey,
    event.observed_at,
  );

  conn
    .insert(timelineEvents)
    .values({
      id: hashId(
        "timeline_event",
        `${event.platform}:${event.account_key}:${payload.sourceEventKey}`,
      ),
      platform: event.platform,
      accountKey: event.account_key,
      conversationId,
      sourceEventKey: payload.sourceEventKey,
      eventKind: payload.eventKind,
      actorContactId,
      actorSourceKey: payload.actorSourceKey ?? null,
      actorName: actorContactId ? (cache.contactNameMap.get(actorContactId) ?? null) : null,
      subjectContactId,
      eventAt: payload.eventAt,
      text: normalizeText(payload.text ?? null),
      metadataJson: payload.metadata ? JSON.stringify(payload.metadata) : null,
      createdAt: event.observed_at,
      updatedAt: event.observed_at,
    })
    .onConflictDoUpdate({
      target: timelineEvents.id,
      set: {
        actorContactId,
        actorSourceKey: payload.actorSourceKey ?? null,
        actorName: actorContactId ? (cache.contactNameMap.get(actorContactId) ?? null) : null,
        subjectContactId,
        eventAt: payload.eventAt,
        text: normalizeText(payload.text ?? null),
        metadataJson: payload.metadata ? JSON.stringify(payload.metadata) : null,
        updatedAt: event.observed_at,
      },
    })
    .run();
}

function refreshConversationSummariesForIds(
  conn: LocalDbExecutor,
  conversationIds: Set<string>,
): void {
  for (const chunk of chunkArray([...conversationIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE conversations
      SET
        last_message_id = (
          SELECT m.id
          FROM messages m
          WHERE m.conversation_id = conversations.id
          ORDER BY m.sent_at DESC, m.updated_at DESC, m.id DESC
          LIMIT 1
        ),
        last_message_at = (
          SELECT m.sent_at
          FROM messages m
          WHERE m.conversation_id = conversations.id
          ORDER BY m.sent_at DESC, m.updated_at DESC, m.id DESC
          LIMIT 1
        ),
        last_message_preview = (
          SELECT m.content
          FROM messages m
          WHERE m.conversation_id = conversations.id
          ORDER BY m.sent_at DESC, m.updated_at DESC, m.id DESC
          LIMIT 1
        ),
        unread_count = (
          CASE
            WHEN conversations.subtype = 'deleted' THEN 0
            ELSE (
              SELECT COUNT(*)
              FROM messages m
              WHERE m.conversation_id = conversations.id
                AND m.is_from_me = 0
                AND m.is_deleted = 0
                AND m.read_at IS NULL
            )
          END
        )
      WHERE id IN (${sqlValueList(chunk)})
    `);
  }
}

function refreshContactFanoutForIds(conn: LocalDbExecutor, contactIds: Set<string>): void {
  for (const chunk of chunkArray([...contactIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE messages
      SET sender_name = (
        SELECT name FROM contacts WHERE id = messages.sender_contact_id
      )
      WHERE sender_contact_id IN (${sqlValueList(chunk)})
    `);
    conn.run(sql`
      UPDATE conversation_participants
      SET participant_name = (
        SELECT name FROM contacts WHERE id = conversation_participants.contact_id
      )
      WHERE contact_id IN (${sqlValueList(chunk)})
    `);
    conn.run(sql`
      UPDATE timeline_events
      SET actor_name = (
        SELECT name FROM contacts WHERE id = timeline_events.actor_contact_id
      )
      WHERE actor_contact_id IN (${sqlValueList(chunk)})
    `);
    conn.run(sql`
      UPDATE message_reactions
      SET reactor_name = (
        SELECT name FROM contacts WHERE id = message_reactions.reactor_contact_id
      )
      WHERE reactor_contact_id IN (${sqlValueList(chunk)})
    `);
  }
}

function expandDirtyConversationIds(conn: LocalDbExecutor, changes: ProjectionChangeSet): void {
  if (changes.dirtyContactIds.size === 0) {
    return;
  }

  for (const chunk of chunkArray([...changes.dirtyContactIds], SQL_CHUNK_SIZE)) {
    const rows = conn.all<{ conversation_id: string }>(sql`
      SELECT DISTINCT conversation_id
      FROM conversation_participants
      WHERE contact_id IN (${sqlValueList(chunk)})
    `);
    for (const row of rows) {
      changes.dirtyConversationIds.add(row.conversation_id);
    }
  }
}

function refreshParticipantNamesForIds(conn: LocalDbExecutor, conversationIds: Set<string>): void {
  for (const chunk of chunkArray([...conversationIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE conversations
      SET participant_names = (
        SELECT GROUP_CONCAT(cp.participant_name, ' | ')
        FROM conversation_participants cp
        WHERE cp.conversation_id = conversations.id
          AND cp.is_active = 1
          AND cp.participant_name IS NOT NULL
          AND cp.participant_name <> ''
      )
      WHERE id IN (${sqlValueList(chunk)})
    `);
  }
}

function refreshConversationNamesForIds(conn: LocalDbExecutor, conversationIds: Set<string>): void {
  for (const chunk of chunkArray([...conversationIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE conversations
      SET name = participant_names
      WHERE id IN (${sqlValueList(chunk)})
        AND (
          name IS NULL
          OR name = ''
          OR name = source_conversation_key
          OR name GLOB '+*'
          OR name LIKE 'imessage:%'
          OR name LIKE '%@%'
        )
        AND type = 'dm'
        AND participant_names IS NOT NULL
        AND participant_names <> ''
    `);
  }
}

function refreshMessageConversationNamesForIds(
  conn: LocalDbExecutor,
  conversationIds: Set<string>,
): void {
  for (const chunk of chunkArray([...conversationIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE messages
      SET conversation_name = (
        SELECT name FROM conversations WHERE id = messages.conversation_id
      )
      WHERE conversation_id IN (${sqlValueList(chunk)})
    `);
  }
}

function expandDirtyMessageIds(conn: LocalDbExecutor, changes: ProjectionChangeSet): void {
  if (changes.dirtyConversationIds.size > 0) {
    for (const chunk of chunkArray([...changes.dirtyConversationIds], SQL_CHUNK_SIZE)) {
      const rows = conn.all<{ id: string }>(sql`
        SELECT id
        FROM messages
        WHERE conversation_id IN (${sqlValueList(chunk)})
      `);
      for (const row of rows) {
        changes.dirtyMessageIds.add(row.id);
      }
    }
  }

  if (changes.dirtyContactIds.size > 0) {
    for (const chunk of chunkArray([...changes.dirtyContactIds], SQL_CHUNK_SIZE)) {
      const rows = conn.all<{ id: string }>(sql`
        SELECT id
        FROM messages
        WHERE sender_contact_id IN (${sqlValueList(chunk)})
      `);
      for (const row of rows) {
        changes.dirtyMessageIds.add(row.id);
      }
    }
  }
}

function refreshAttachmentCountsForIds(conn: LocalDbExecutor, messageIds: Set<string>): void {
  for (const chunk of chunkArray([...messageIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE messages
      SET attachment_count = (
        SELECT COUNT(*)
        FROM message_attachments ma
        WHERE ma.message_id = messages.id
      )
      WHERE id IN (${sqlValueList(chunk)})
    `);
  }
}

function refreshReactionCountsForIds(conn: LocalDbExecutor, messageIds: Set<string>): void {
  for (const chunk of chunkArray([...messageIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE messages
      SET reaction_count = (
        SELECT COUNT(*)
        FROM message_reactions mr
        WHERE mr.message_id = messages.id
          AND mr.is_active = 1
      )
      WHERE id IN (${sqlValueList(chunk)})
    `);
  }
}

function refreshReplyLinksForIds(conn: LocalDbExecutor, messageIds: Set<string>): void {
  for (const chunk of chunkArray([...messageIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      UPDATE messages
      SET reply_to_message_id = (
        SELECT parent.id
        FROM raw_events child_re
        JOIN messages parent
          ON parent.platform = child_re.platform
         AND parent.account_key = child_re.account_key
         AND parent.platform_message_id = json_extract(child_re.payload_json, '$.replyToSourceMessageKey')
        WHERE child_re.entity_kind = 'message'
          AND child_re.platform = messages.platform
          AND child_re.account_key = messages.account_key
          AND json_extract(child_re.payload_json, '$.sourceMessageKey') = messages.platform_message_id
        ORDER BY child_re.observed_at DESC, child_re.id DESC
        LIMIT 1
      )
      WHERE id IN (${sqlValueList(chunk)})
    `);
  }
}

function refreshMessageSearchIndexForIds(conn: LocalDbExecutor, messageIds: Set<string>): void {
  for (const chunk of chunkArray([...messageIds], SQL_CHUNK_SIZE)) {
    conn.run(sql`
      DELETE FROM messages_fts
      WHERE message_id IN (${sqlValueList(chunk)})
    `);
    conn.run(sql`
      INSERT INTO messages_fts (message_id, sender_name, conversation_name, participant_names, attachment_text, content)
      SELECT message_id, sender_name, conversation_name, participant_names, attachment_text, content
      FROM message_fts_source
      WHERE message_id IN (${sqlValueList(chunk)})
    `);
  }
}

function finalizeRealtimeProjection(conn: LocalDbExecutor, changes: ProjectionChangeSet): void {
  if (changes.dirtyConversationIds.size > 0) {
    refreshConversationSummariesForIds(conn, changes.dirtyConversationIds);
  }
  if (changes.dirtyMessageIds.size > 0) {
    refreshReactionCountsForIds(conn, changes.dirtyMessageIds);
  }
}

function finalizeDeferredProjection(
  conn: LocalDbExecutor,
  cache: ProjectionCache,
  changes: ProjectionChangeSet,
): void {
  if (changes.dirtyContactIds.size > 0) {
    refreshContactFanoutForIds(conn, changes.dirtyContactIds);
    syncContactNameCache(conn, cache, changes.dirtyContactIds);
  }

  expandDirtyConversationIds(conn, changes);
  if (changes.dirtyConversationIds.size > 0) {
    refreshParticipantNamesForIds(conn, changes.dirtyConversationIds);
    refreshConversationNamesForIds(conn, changes.dirtyConversationIds);
    syncConversationNameCache(conn, cache, changes.dirtyConversationIds);
    refreshMessageConversationNamesForIds(conn, changes.dirtyConversationIds);
    refreshConversationSummariesForIds(conn, changes.dirtyConversationIds);
  }

  expandDirtyMessageIds(conn, changes);
  if (changes.dirtyMessageIds.size > 0) {
    refreshAttachmentCountsForIds(conn, changes.dirtyMessageIds);
    refreshReactionCountsForIds(conn, changes.dirtyMessageIds);
    refreshMessageSearchIndexForIds(conn, changes.dirtyMessageIds);
  }

  if (changes.dirtyReplyMessageIds.size > 0) {
    refreshReplyLinksForIds(conn, changes.dirtyReplyMessageIds);
  }
}

function summarizeResult(
  db: CuedDatabase,
  appliedRawEvents: number,
  projectionWatermark: number,
  rangeStartRowId: number | null,
  rangeEndRowId: number | null,
  completed: boolean,
  nextStartRowId: number | null,
): ProjectionRangeResult {
  const overview = buildOverview(db);
  return {
    ...overview,
    appliedRawEvents,
    projectionWatermark,
    completed,
    nextStartRowId,
    rangeStartRowId,
    rangeEndRowId,
  };
}

function projectEventBatch(
  db: CuedDatabase,
  input: {
    mode: ProjectionMode;
    rawEvents: RawEventRow[];
    projectionWatermark: number | null;
    lastRebuildAt?: number | null;
  },
): void {
  const cache = input.mode === "rebuild" ? resetProjectionCache(db) : getProjectionCache(db);

  db.orm().transaction((tx) => {
    const projectedAt = Date.now();
    const changes = createProjectionChangeSet();
    if (input.mode === "rebuild") {
      clearProjectedState(tx);
    }

    for (const event of input.rawEvents) {
      const shapedEvent = {
        platform: event.platform,
        account_key: event.account_key,
        event_kind: event.event_kind,
        observed_at: event.observed_at,
        payload_json: event.payload_json,
      };

      if (input.mode === "realtime") {
        if (event.entity_kind === "conversation") {
          projectRealtimeConversationObservation(tx, cache, changes, shapedEvent);
        } else if (event.entity_kind === "message") {
          projectRealtimeMessageEvent(tx, cache, changes, shapedEvent);
        } else if (event.entity_kind === "reaction") {
          projectReactionEvent(tx, cache, changes, shapedEvent);
        } else if (event.entity_kind === "timeline_event") {
          projectTimelineEvent(tx, cache, shapedEvent);
        }
        continue;
      }

      if (event.entity_kind === "contact") {
        projectContactObservation(tx, cache, changes, shapedEvent);
        continue;
      }
      if (event.entity_kind === "conversation") {
        projectConversationObservation(tx, cache, changes, shapedEvent);
        continue;
      }
      if (event.entity_kind === "message") {
        projectMessageEvent(tx, cache, changes, shapedEvent);
        continue;
      }
      if (event.entity_kind === "reaction") {
        projectReactionEvent(tx, cache, changes, shapedEvent);
        continue;
      }
      if (event.entity_kind === "timeline_event") {
        projectTimelineEvent(tx, cache, shapedEvent);
      }
    }

    if (input.mode === "realtime") {
      finalizeRealtimeProjection(tx, changes);
      return;
    }

    finalizeDeferredProjection(tx, cache, changes);
    if (input.projectionWatermark != null) {
      upsertProjectionState(tx, {
        projectionWatermark: input.projectionWatermark,
        lastProjectedAt: projectedAt,
        lastRebuildAt: input.lastRebuildAt,
      });
    }
  });
}

function projectRangeInternal(
  db: CuedDatabase,
  input: {
    mode: ProjectionMode;
    startRowId: number;
    endRowId: number;
    limit?: number;
  },
): ProjectionRangeResult {
  if (input.endRowId < input.startRowId) {
    const projection = db.getProjectionState();
    return summarizeResult(db, 0, projection.projection_watermark, null, null, true, null);
  }

  const currentProjectionState = db.getProjectionState();
  const rawEvents = db.listRawEventsInRange(input.startRowId, input.endRowId, input.limit);
  if (rawEvents.length === 0) {
    return summarizeResult(
      db,
      0,
      currentProjectionState.projection_watermark,
      input.startRowId,
      input.endRowId,
      true,
      null,
    );
  }

  const appliedEndRowId = rawEvents[rawEvents.length - 1]!.rowid;
  const completed = appliedEndRowId >= input.endRowId;
  const nextStartRowId = completed ? null : appliedEndRowId + 1;
  const deferredProjectionWatermark = Math.max(
    currentProjectionState.projection_watermark,
    appliedEndRowId,
  );
  projectEventBatch(db, {
    mode: input.mode,
    rawEvents,
    projectionWatermark: input.mode === "realtime" ? null : deferredProjectionWatermark,
    lastRebuildAt: input.mode === "rebuild" ? Date.now() : undefined,
  });

  const projectionWatermark =
    input.mode === "realtime"
      ? db.getProjectionState().projection_watermark
      : deferredProjectionWatermark;

  return summarizeResult(
    db,
    rawEvents.length,
    projectionWatermark,
    input.startRowId,
    input.endRowId,
    completed,
    nextStartRowId,
  );
}

export function projectRealtimeRange(
  db: CuedDatabase,
  options: {
    startRowId: number;
    endRowId: number;
    batchSize?: number;
  },
): ProjectionRangeResult {
  let currentStartRowId = options.startRowId;
  let lastResult = summarizeResult(
    db,
    0,
    db.getProjectionState().projection_watermark,
    null,
    null,
    true,
    null,
  );
  while (currentStartRowId <= options.endRowId) {
    const result = projectRangeInternal(db, {
      mode: "realtime",
      startRowId: currentStartRowId,
      endRowId: options.endRowId,
      limit: options.batchSize,
    });
    lastResult = {
      ...result,
      appliedRawEvents: lastResult.appliedRawEvents + result.appliedRawEvents,
      rangeStartRowId: options.startRowId,
      rangeEndRowId: options.endRowId,
    };
    if (result.completed || result.nextStartRowId == null) {
      break;
    }
    currentStartRowId = result.nextStartRowId;
  }
  return {
    ...lastResult,
    completed: true,
    nextStartRowId: null,
    rangeStartRowId: options.startRowId,
    rangeEndRowId: options.endRowId,
  };
}

export function projectDeferredRange(
  db: CuedDatabase,
  options: {
    startRowId: number;
    endRowId: number;
    limit?: number;
  },
): ProjectionRangeResult {
  return projectRangeInternal(db, {
    mode: "deferred",
    startRowId: options.startRowId,
    endRowId: options.endRowId,
    limit: options.limit,
  });
}

export function projectPendingRawEvents(
  db: CuedDatabase,
  options?: {
    limit?: number;
  },
): ProjectionOverview {
  const backlog = db.getProjectionBacklog();
  if (backlog.pending_raw_events === 0) {
    const result = summarizeResult(db, 0, backlog.projection_watermark, null, null, true, null);
    return {
      contacts: result.contacts,
      conversations: result.conversations,
      messages: result.messages,
      rawEvents: result.rawEvents,
      appliedRawEvents: result.appliedRawEvents,
      projectionWatermark: result.projectionWatermark,
    };
  }

  const result = projectDeferredRange(db, {
    startRowId: backlog.projection_watermark + 1,
    endRowId: backlog.max_raw_event_rowid,
    limit: options?.limit,
  });

  return {
    contacts: result.contacts,
    conversations: result.conversations,
    messages: result.messages,
    rawEvents: result.rawEvents,
    appliedRawEvents: result.appliedRawEvents,
    projectionWatermark: result.projectionWatermark,
  };
}

export function rebuildProjectedState(db: CuedDatabase): ProjectionOverview {
  const rawEvents = db.listRawEventsAfter(0);
  if (rawEvents.length === 0) {
    projectEventBatch(db, {
      mode: "rebuild",
      rawEvents: [],
      projectionWatermark: 0,
      lastRebuildAt: Date.now(),
    });
    const result = summarizeResult(db, 0, 0, null, null, true, null);
    return {
      contacts: result.contacts,
      conversations: result.conversations,
      messages: result.messages,
      rawEvents: result.rawEvents,
      appliedRawEvents: result.appliedRawEvents,
      projectionWatermark: result.projectionWatermark,
    };
  }

  projectEventBatch(db, {
    mode: "rebuild",
    rawEvents,
    projectionWatermark: rawEvents[rawEvents.length - 1]!.rowid,
    lastRebuildAt: Date.now(),
  });

  const result = summarizeResult(
    db,
    rawEvents.length,
    rawEvents[rawEvents.length - 1]!.rowid,
    1,
    rawEvents[rawEvents.length - 1]!.rowid,
    true,
    null,
  );
  return {
    contacts: result.contacts,
    conversations: result.conversations,
    messages: result.messages,
    rawEvents: result.rawEvents,
    appliedRawEvents: result.appliedRawEvents,
    projectionWatermark: result.projectionWatermark,
  };
}

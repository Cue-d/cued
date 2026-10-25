import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ContactAliasPayload } from "../../core/types/provider.js";
import type { LocalDrizzleDatabase } from "../../db/database.js";
import type { ProjectionCache } from "./projection-cache.js";

type Executor = Pick<LocalDrizzleDatabase, "all" | "get" | "run">;
type Row = Record<string, string | number | null> & { id: string };
function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

type Changes = {
  dirtyContactIds: Set<string>;
  dirtyConversationIds: Set<string>;
  dirtyConversationSummaryIds: Set<string>;
  dirtyMessageIds: Set<string>;
  touchedAttachments: boolean;
  touchedReactions: boolean;
};

// Only authenticated WhatsApp LID mappings have defined migration semantics.
export function assertWhatsAppAlias(platform: string, payload: ContactAliasPayload): void {
  if (
    platform !== "whatsapp" ||
    !/^whatsapp:\d+@lid$/.test(payload.aliasSourceEntityKey) ||
    !/^whatsapp:\d+@s\.whatsapp\.net$/.test(payload.canonicalSourceEntityKey)
  ) {
    throw new Error("Identity aliases must be verified WhatsApp LID-to-phone mappings");
  }
}

export function canonicalizeWhatsAppSourceKey(
  conn: Executor,
  accountKey: string,
  value: string,
): string {
  const match = /^(whatsapp:)?(\d+@lid)(:.*)?$/.exec(value);
  if (!match) return value;
  const row = conn.get<{ canonical_source_key: string }>(
    sql`SELECT canonical_source_key FROM provider_identity_aliases WHERE platform = 'whatsapp' AND account_key = ${accountKey} AND alias_source_key = ${`whatsapp:${match[2]}`}`,
  );
  return row
    ? `${match[1] ?? ""}${row.canonical_source_key.slice("whatsapp:".length)}${match[3] ?? ""}`
    : value;
}

export function canonicalizeWhatsAppPayload(
  conn: Executor,
  platform: string,
  accountKey: string,
  payloadJson: string,
): string {
  if (platform !== "whatsapp" || !payloadJson.includes("@lid")) return payloadJson;
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  const mapped = new Map<string, string>();
  function canonical(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const match = /^(whatsapp:)?(\d+@lid)(:.*)?$/.exec(value);
    if (!match) return value;
    const lid = match[2]!;
    if (!mapped.has(lid)) mapped.set(lid, canonicalizeWhatsAppSourceKey(conn, accountKey, lid));
    return `${match[1] ?? ""}${mapped.get(lid)}${match[3] ?? ""}`;
  }
  for (const key of [
    "sourceEntityKey",
    "sourceConversationKey",
    "sourceMessageKey",
    "senderSourceKey",
    "replyToSourceMessageKey",
    "reactorSourceKey",
    "participantSourceKey",
    "sourceEventKey",
    "sourceCallKey",
    "actorSourceKey",
    "subjectSourceKey",
    "initiatorSourceKey",
    "primaryRemoteSourceKey",
  ]) {
    if (key in payload) payload[key] = canonical(payload[key]);
  }
  if (Array.isArray(payload.participants))
    payload.participants = payload.participants.map((p) => ({
      ...p,
      sourceEntityKey: canonical(p.sourceEntityKey),
    }));
  if (Array.isArray(payload.handles))
    payload.handles = payload.handles.map((h) =>
      h.type === "whatsapp_jid" ? { ...h, value: canonical(h.value) } : h,
    );
  if (Array.isArray(payload.attachments))
    payload.attachments = payload.attachments.map((a) => ({
      ...a,
      ...(typeof a.sourceAttachmentKey === "string"
        ? { sourceAttachmentKey: canonical(a.sourceAttachmentKey) }
        : {}),
    }));
  return JSON.stringify(payload);
}

function updateRow(
  conn: Executor,
  table: string,
  id: string,
  values: Record<string, string | number | null>,
): void {
  const assignments = Object.entries(values).map(
    ([key, value]) => sql`${sql.identifier(key)} = ${value}`,
  );
  if (assignments.length)
    conn.run(
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(assignments, sql`, `)} WHERE id = ${id}`,
    );
}

function mergeRow(conn: Executor, table: string, from: Row, into: Row): void {
  // Preserve the canonical row ID, but retain the most recently observed payload.
  const { id: _id, ...values } = Number(from.updated_at) > Number(into.updated_at) ? from : into;
  values.created_at = Math.min(Number(from.created_at), Number(into.created_at));
  if (table === "messages") {
    values.is_deleted = Number(from.is_deleted) || Number(into.is_deleted);
    values.deleted_at = from.deleted_at ?? into.deleted_at;
  }
  updateRow(conn, table, into.id, values);
}

function migrateParticipants(
  conn: Executor,
  field: "contact_id" | "conversation_id",
  from: string,
  into: string,
  alias: string,
  canonical: string,
  accountKey?: string,
): void {
  const rows = conn.all<Record<string, string | number | null>>(
    sql`SELECT * FROM conversation_participants WHERE ${sql.identifier(field)} = ${from} ${accountKey ? sql`AND source_participant_key = ${alias} AND conversation_id IN (SELECT id FROM conversations WHERE platform = 'whatsapp' AND account_key = ${accountKey})` : sql``}`,
  );
  for (const row of rows) {
    conn.run(
      sql`DELETE FROM conversation_participants WHERE conversation_id = ${row.conversation_id} AND contact_id = ${row.contact_id} AND source_participant_key IS ${row.source_participant_key}`,
    );
    row[field] = into;
    if (row.source_participant_key === alias) row.source_participant_key = canonical;
    const columns = Object.keys(row);
    conn.run(sql`INSERT INTO conversation_participants (${sql.join(columns.map(sql.identifier), sql`, `)}) VALUES (${sql.join(
      Object.values(row).map((v) => sql`${v}`),
      sql`, `,
    )})
      ON CONFLICT(conversation_id, contact_id, source_participant_key) DO UPDATE SET
        participant_name = excluded.participant_name, role = excluded.role, is_self = excluded.is_self,
        joined_at = excluded.joined_at, left_at = excluded.left_at, is_active = excluded.is_active, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= conversation_participants.updated_at`);
  }
}

function migrateAttachment(conn: Executor, row: Row, messageId: string, key: string): void {
  const existing = conn.get<Row>(
    sql`SELECT * FROM message_attachments WHERE platform = 'whatsapp' AND account_key = ${row.account_key} AND source_attachment_key = ${key}`,
  );
  if (existing && existing.id !== row.id) {
    const merged = { ...row, message_id: messageId, source_attachment_key: key };
    mergeRow(conn, "message_attachments", merged, existing);
    // Local cache/content rows survive where the winner has no corresponding artifact.
    conn.run(
      sql`UPDATE OR IGNORE attachment_cache SET attachment_id = ${existing.id} WHERE attachment_id = ${row.id}`,
    );
    conn.run(
      sql`UPDATE OR IGNORE attachment_content SET attachment_id = ${existing.id} WHERE attachment_id = ${row.id}`,
    );
    conn.run(
      sql`DELETE FROM attachment_content_fts WHERE attachment_id IN (${row.id}, ${existing.id})`,
    );
    conn.run(sql`INSERT INTO attachment_content_fts (attachment_id, filename, title, content)
      SELECT a.id, a.filename, a.title, c.text_content FROM message_attachments a JOIN attachment_content c ON c.attachment_id = a.id WHERE a.id = ${existing.id} AND c.text_content IS NOT NULL`);
    conn.run(sql`DELETE FROM message_attachments WHERE id = ${row.id}`);
  } else
    updateRow(conn, "message_attachments", row.id, {
      message_id: messageId,
      source_attachment_key: key,
    });
}

export function projectWhatsAppIdentityAlias(
  conn: Executor,
  cache: ProjectionCache,
  changes: Changes,
  event: { platform: string; account_key: string; observed_at: number; payload_json: string },
): void {
  const payload = JSON.parse(event.payload_json) as ContactAliasPayload;
  assertWhatsAppAlias(event.platform, payload);
  const alias = payload.aliasSourceEntityKey;
  const canonical = payload.canonicalSourceEntityKey;
  const account = event.account_key;
  const prior = conn.get<{ canonical_source_key: string }>(
    sql`SELECT canonical_source_key FROM provider_identity_aliases WHERE platform = 'whatsapp' AND account_key = ${account} AND alias_source_key = ${alias}`,
  );
  if (prior) {
    if (prior.canonical_source_key !== canonical)
      throw new Error("Conflicting WhatsApp identity alias");
    return;
  }
  const lid = alias.slice("whatsapp:".length);
  const pn = canonical.slice("whatsapp:".length);
  const sourcePrefix = `whatsapp:${account}:`;
  function findContact(key: string): string | undefined {
    return (
      cache.sourceContactMap.get(`${sourcePrefix}${key}`) ??
      conn.get<{ id: string }>(
        sql`SELECT id FROM contacts WHERE id = ${hashId("contact", `${sourcePrefix}${key}`)}`,
      )?.id
    );
  }
  const oldContact = findContact(alias);
  const shared =
    oldContact != null &&
    Boolean(
      conn.get(
        sql`SELECT 1 FROM contact_sources WHERE contact_id = ${oldContact} AND NOT(platform = 'whatsapp' AND account_key = ${account}) LIMIT 1`,
      ),
    );
  const newContact =
    findContact(canonical) ??
    (shared ? hashId("contact", `${sourcePrefix}${canonical}`) : oldContact);
  if (newContact && shared && oldContact) {
    conn.run(sql`INSERT OR IGNORE INTO contacts (id,kind,name,photo_url,company,archived,created_at,updated_at)
      SELECT ${newContact},kind,name,photo_url,company,archived,created_at,updated_at FROM contacts WHERE id = ${oldContact}`);
  }
  conn.run(sql`INSERT INTO provider_identity_aliases (platform, account_key, alias_source_key, canonical_source_key, former_contact_id, canonical_contact_id, observed_at)
    VALUES ('whatsapp', ${account}, ${alias}, ${canonical}, ${shared ? null : (oldContact ?? null)}, ${newContact ?? null}, ${event.observed_at})`);

  if (newContact) {
    cache.sourceContactMap.set(`${sourcePrefix}${alias}`, newContact);
    cache.sourceContactMap.set(`${sourcePrefix}${canonical}`, newContact);
    conn.run(sql`INSERT OR IGNORE INTO contact_sources (id, contact_id, platform, account_key, source_entity_key, first_seen_at, last_seen_at)
      VALUES (${hashId("contact_source", `${sourcePrefix}${canonical}`)}, ${newContact}, 'whatsapp', ${account}, ${canonical}, ${event.observed_at}, ${event.observed_at})`);
    if (oldContact && oldContact !== newContact) {
      if (!shared) cache.contactMergeAliasMap.set(oldContact, newContact);
      conn.run(
        sql`UPDATE contact_sources SET contact_id = ${newContact} WHERE contact_id = ${oldContact} ${shared ? sql`AND platform = 'whatsapp' AND account_key = ${account} AND source_entity_key = ${alias}` : sql``}`,
      );
      // Historical deterministic LID handles may have coalesced unrelated accounts.
      // Split only this account's references, leaving ambiguous memories on the old contact.
      for (const [table, column, sourceColumn] of [
        ["messages", "sender_contact_id", "sender_source_key"],
        ["message_reactions", "reactor_contact_id", "reactor_source_key"],
        ["timeline_events", "actor_contact_id", "actor_source_key"],
        ["timeline_events", "subject_contact_id", "subject_source_key"],
      ]) {
        conn.run(
          sql`UPDATE ${sql.identifier(table!)} SET ${sql.identifier(column!)} = ${newContact} WHERE ${sql.identifier(column!)} = ${oldContact} ${shared ? sql`AND platform = 'whatsapp' AND account_key = ${account} AND ${sql.identifier(sourceColumn!)} = ${alias}` : sql``}`,
        );
      }
      if (!shared) {
        conn.run(
          sql`UPDATE contact_handles SET contact_id = ${newContact} WHERE contact_id = ${oldContact}`,
        );
        conn.run(
          sql`UPDATE contact_memories SET contact_id = ${newContact} WHERE contact_id = ${oldContact}`,
        );
      }
      migrateParticipants(
        conn,
        "contact_id",
        oldContact,
        newContact,
        alias,
        canonical,
        shared ? account : undefined,
      );
      conn.run(
        sql`UPDATE contacts SET name = COALESCE(name, (SELECT name FROM contacts WHERE id = ${oldContact})), photo_url = COALESCE(photo_url, (SELECT photo_url FROM contacts WHERE id = ${oldContact})), company = COALESCE(company, (SELECT company FROM contacts WHERE id = ${oldContact})) WHERE id = ${newContact}`,
      );
      if (!shared) conn.run(sql`DELETE FROM contacts WHERE id = ${oldContact}`);
      changes.dirtyContactIds.add(oldContact);
    }
    if (oldContact === newContact)
      migrateParticipants(conn, "contact_id", oldContact, newContact, alias, canonical, account);
    changes.dirtyContactIds.add(newContact);
  }

  const oldConversation = conn.get<Row>(
    sql`SELECT * FROM conversations WHERE platform = 'whatsapp' AND account_key = ${account} AND source_conversation_key = ${alias}`,
  );
  const canonicalConversation = conn.get<Row>(
    sql`SELECT * FROM conversations WHERE platform = 'whatsapp' AND account_key = ${account} AND source_conversation_key = ${canonical}`,
  );
  const conversation = canonicalConversation ?? oldConversation;
  if (oldConversation && conversation) {
    if (oldConversation.id !== conversation.id) {
      migrateParticipants(
        conn,
        "conversation_id",
        oldConversation.id,
        conversation.id,
        alias,
        canonical,
      );
      conn.run(
        sql`UPDATE messages SET conversation_id = ${conversation.id} WHERE conversation_id = ${oldConversation.id}`,
      );
      conn.run(
        sql`UPDATE timeline_events SET conversation_id = ${conversation.id} WHERE conversation_id = ${oldConversation.id}`,
      );
      conn.run(sql`DELETE FROM conversations WHERE id = ${oldConversation.id}`);
    } else
      updateRow(conn, "conversations", conversation.id, { source_conversation_key: canonical });
    cache.conversationMap.set(`${sourcePrefix}${alias}`, conversation.id);
    cache.conversationMap.set(`${sourcePrefix}${canonical}`, conversation.id);
    changes.dirtyConversationIds.add(conversation.id);
    changes.dirtyConversationSummaryIds.add(conversation.id);
  }

  // Keys are delimiter-prefixed: a LID cannot accidentally match another account or group.
  const prefix = `${lid}:`;
  const oldMessages = conn.all<Row>(
    sql`SELECT * FROM messages WHERE platform = 'whatsapp' AND account_key = ${account} AND platform_message_id >= ${prefix} AND platform_message_id < ${`${lid};`}`,
  );
  for (const row of oldMessages) {
    const key = `${pn}:${String(row.platform_message_id).slice(prefix.length)}`;
    const existing = conn.get<Row>(
      sql`SELECT * FROM messages WHERE platform = 'whatsapp' AND account_key = ${account} AND platform_message_id = ${key}`,
    );
    const winner = existing ?? row;
    for (const attachment of conn.all<Row>(
      sql`SELECT * FROM message_attachments WHERE message_id = ${row.id}`,
    )) {
      const attachmentKey = String(attachment.source_attachment_key).startsWith(prefix)
        ? `${pn}:${String(attachment.source_attachment_key).slice(prefix.length)}`
        : String(attachment.source_attachment_key);
      migrateAttachment(conn, attachment, winner.id, attachmentKey);
    }
    if (existing && existing.id !== row.id) {
      mergeRow(
        conn,
        "messages",
        { ...row, platform_message_id: key, conversation_id: existing.conversation_id },
        existing,
      );
      conn.run(
        sql`UPDATE messages SET reply_to_message_id = ${existing.id} WHERE reply_to_message_id = ${row.id}`,
      );
      conn.run(
        sql`UPDATE message_reactions SET message_id = ${existing.id} WHERE message_id = ${row.id}`,
      );
      conn.run(sql`DELETE FROM messages_fts WHERE message_id = ${row.id}`);
      conn.run(sql`DELETE FROM message_fts_index_queue WHERE message_id = ${row.id}`);
      conn.run(sql`DELETE FROM messages WHERE id = ${row.id}`);
    } else updateRow(conn, "messages", row.id, { platform_message_id: key });
    changes.dirtyMessageIds.add(winner.id);
  }
  // Source references occur in group chats too; the mapping is still account-scoped.
  for (const [table, column] of [
    ["messages", "sender_source_key"],
    ["message_reactions", "reactor_source_key"],
    ["timeline_events", "actor_source_key"],
    ["timeline_events", "subject_source_key"],
  ]) {
    conn.run(
      sql`UPDATE ${sql.identifier(table!)} SET ${sql.identifier(column!)} = ${canonical} WHERE platform = 'whatsapp' AND account_key = ${account} AND ${sql.identifier(column!)} = ${alias}`,
    );
  }
  const reactions = conn.all<Row>(
    sql`SELECT * FROM message_reactions WHERE platform = 'whatsapp' AND account_key = ${account} AND (source_reaction_key LIKE ${`${prefix}%`} OR instr(source_reaction_key, ${alias}) > 0)`,
  );
  for (const row of reactions) {
    const message = conn.get<{ platform_message_id: string }>(
      sql`SELECT platform_message_id FROM messages WHERE id = ${row.message_id}`,
    )!;
    const key = `${message.platform_message_id}:${row.reactor_source_key ?? "__me__"}:${row.emoji}`;
    const existing = conn.get<Row>(
      sql`SELECT * FROM message_reactions WHERE platform = 'whatsapp' AND account_key = ${account} AND source_reaction_key = ${key}`,
    );
    if (existing && existing.id !== row.id) {
      mergeRow(conn, "message_reactions", { ...row, source_reaction_key: key }, existing);
      conn.run(sql`DELETE FROM message_reactions WHERE id = ${row.id}`);
    } else updateRow(conn, "message_reactions", row.id, { source_reaction_key: key });
    changes.dirtyMessageIds.add(String(row.message_id));
  }
  for (const row of conn.all<Row>(
    sql`SELECT * FROM timeline_events WHERE platform = 'whatsapp' AND account_key = ${account} AND source_event_key LIKE ${`${prefix}%`}`,
  )) {
    const key = `${pn}:${String(row.source_event_key).slice(prefix.length)}`;
    const existing = conn.get<Row>(
      sql`SELECT * FROM timeline_events WHERE platform = 'whatsapp' AND account_key = ${account} AND source_event_key = ${key}`,
    );
    if (existing && existing.id !== row.id) {
      mergeRow(conn, "timeline_events", { ...row, source_event_key: key }, existing);
      conn.run(sql`DELETE FROM timeline_events WHERE id = ${row.id}`);
    } else updateRow(conn, "timeline_events", row.id, { source_event_key: key });
  }
  changes.touchedAttachments = true;
  changes.touchedReactions = true;
}

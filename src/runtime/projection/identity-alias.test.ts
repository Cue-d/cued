import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRawEventInput } from "../../core/types/provider.js";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents, rebuildProjectedState } from "./projector.js";
import { readCanonicalProjectionSnapshot } from "./replay-snapshot.js";

const lid = "123456@lid";
const pn = "15551234567@s.whatsapp.net";
const source = (jid: string) => `whatsapp:${jid}`;
let clock = 100;
function event(
  entityKind: ProviderRawEventInput["entityKind"],
  eventKind: string,
  payload: Record<string, unknown>,
  accountKey = "a",
): ProviderRawEventInput {
  const id = randomUUID();
  return {
    id,
    platform: "whatsapp",
    accountKey,
    entityKind,
    eventKind,
    payload,
    observedAt: clock++,
    dedupeKey: id,
  };
}
function contact(jid: string, account = "a") {
  return event(
    "contact",
    "observed",
    {
      sourceEntityKey: source(jid),
      fields: { display_name: jid === pn ? "Phone person" : "LID person" },
      handles: [],
    },
    account,
  );
}
function message(jid: string, id = "m", account = "a", content = "hello") {
  return event(
    "message",
    "created",
    {
      sourceMessageKey: `${jid}:${id}`,
      sourceConversationKey: source(jid),
      senderSourceKey: source(jid),
      sentAt: 1000,
      content,
      attachments: [{ id: "att", filename: "photo.jpg" }],
    },
    account,
  );
}
function alias(account = "a", target = pn) {
  return event(
    "contact",
    "aliased",
    { aliasSourceEntityKey: source(lid), canonicalSourceEntityKey: source(target) },
    account,
  );
}

describe("WhatsApp identity migration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function database() {
    const dir = mkdtempSync(join(tmpdir(), "cued-alias-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }
  function project(db: CuedDatabase, events: ProviderRawEventInput[]) {
    db.insertRawEvents(events);
    projectPendingRawEvents(db);
    expect(db.orm().all(sql`SELECT * FROM raw_event_projection_failures`)).toEqual([]);
  }

  it("coalesces prior PN/LID duplicates and references, preserves PN IDs, and replays identically", () => {
    const db = database();
    project(db, [
      contact(pn),
      message(pn),
      contact(lid),
      message(lid),
      message(lid, "reply"),
      event("reaction", "added", {
        sourceMessageKey: `${lid}:m`,
        sourceConversationKey: source(lid),
        reactorSourceKey: source(lid),
        emoji: "👍",
        timestamp: 1000,
        isActive: true,
      }),
    ]);
    const before = db
      .orm()
      .get<{ id: string }>(sql`SELECT id FROM messages WHERE platform_message_id = ${`${pn}:m`}`)!;
    project(db, [alias()]);
    expect(db.orm().all(sql`SELECT id FROM contacts`)).toHaveLength(1);
    expect(db.orm().all(sql`SELECT id FROM conversations`)).toHaveLength(1);
    expect(db.orm().all(sql`SELECT id FROM messages`)).toHaveLength(2);
    expect(
      db
        .orm()
        .get<{ id: string }>(sql`SELECT id FROM messages WHERE platform_message_id = ${`${pn}:m`}`)
        ?.id,
    ).toBe(before.id);
    expect(db.orm().all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect(db.orm().all(sql`SELECT id FROM message_attachments`)).toHaveLength(2);
    project(db, [message(lid, "m", "a", "newer"), contact(lid)]);
    expect(db.orm().all(sql`SELECT id FROM messages`)).toHaveLength(2);
    const snapshot = readCanonicalProjectionSnapshot(db);
    rebuildProjectedState(db, { limit: 1 });
    expect(db.orm().all(sql`SELECT * FROM raw_event_projection_failures`)).toEqual([]);
    expect(readCanonicalProjectionSnapshot(db)).toEqual(snapshot);
    db.close();
  });

  it("retains a lone LID row's IDs and keeps other accounts isolated", () => {
    const db = database();
    project(db, [contact(lid), message(lid), contact(lid, "b"), message(lid, "m", "b")]);
    const before = db
      .orm()
      .get<{ id: string }>(sql`SELECT id FROM messages WHERE account_key = 'a'`)!;
    project(db, [alias(), message(pn), contact(pn)]);
    expect(
      db.orm().get<{ id: string }>(sql`SELECT id FROM messages WHERE account_key = 'a'`)?.id,
    ).toBe(before.id);
    expect(
      db
        .orm()
        .get<{ platform_message_id: string }>(
          sql`SELECT platform_message_id FROM messages WHERE account_key = 'b'`,
        )?.platform_message_id,
    ).toBe(`${lid}:m`);
    expect(db.orm().all(sql`SELECT id FROM messages`)).toHaveLength(2);
    const snapshot = readCanonicalProjectionSnapshot(db);
    rebuildProjectedState(db);
    expect(readCanonicalProjectionSnapshot(db)).toEqual(snapshot);
    db.close();
  });

  it("keeps deletion monotonic across delayed history and alias collisions", () => {
    const db = database();
    project(db, [
      message(pn),
      message(lid),
      event("message", "deleted", {
        sourceConversationKey: source(lid),
        sourceMessageKey: `${lid}:m`,
        deletedAt: 2000,
      }),
      alias(),
      message(lid),
    ]);
    expect(
      db.orm().get<{ is_deleted: number }>(sql`SELECT is_deleted FROM messages`)?.is_deleted,
    ).toBe(1);
    expect(db.orm().all(sql`SELECT id FROM messages`)).toHaveLength(1);
    const snapshot = readCanonicalProjectionSnapshot(db);
    rebuildProjectedState(db);
    expect(readCanonicalProjectionSnapshot(db)).toEqual(snapshot);
    db.close();
  });

  it("splits historical cross-account deterministic LID contacts only for the verified account", () => {
    const db = database();
    const historical = (account: string) =>
      event(
        "contact",
        "observed",
        {
          sourceEntityKey: source(lid),
          fields: { display_name: "Shared old LID" },
          handles: [{ type: "whatsapp_jid", value: lid, deterministic: true }],
        },
        account,
      );
    project(db, [
      historical("a"),
      historical("b"),
      message(lid),
      message(lid, "m", "b"),
      contact(pn),
    ]);
    const oldB = db
      .orm()
      .get<{ contact_id: string }>(
        sql`SELECT contact_id FROM contact_sources WHERE account_key = 'b'`,
      )!;
    project(db, [alias()]);
    const a = db
      .orm()
      .get<{ contact_id: string }>(
        sql`SELECT contact_id FROM contact_sources WHERE account_key = 'a' AND source_entity_key = ${source(lid)}`,
      )!;
    expect(a.contact_id).not.toBe(oldB.contact_id);
    expect(
      db
        .orm()
        .get<{ contact_id: string }>(
          sql`SELECT contact_id FROM contact_sources WHERE account_key = 'b'`,
        )?.contact_id,
    ).toBe(oldB.contact_id);
    expect(
      db
        .orm()
        .get<{ sender_contact_id: string }>(
          sql`SELECT sender_contact_id FROM messages WHERE account_key = 'b'`,
        )?.sender_contact_id,
    ).toBe(oldB.contact_id);
    project(db, [alias("b", "15550001111@s.whatsapp.net")]);
    expect(
      db
        .orm()
        .get<{ platform_message_id: string }>(
          sql`SELECT platform_message_id FROM messages WHERE account_key = 'b'`,
        )?.platform_message_id,
    ).toBe("15550001111@s.whatsapp.net:m");
    const snapshot = readCanonicalProjectionSnapshot(db);
    rebuildProjectedState(db, { limit: 1 });
    expect(db.orm().all(sql`SELECT * FROM raw_event_projection_failures`)).toEqual([]);
    expect(readCanonicalProjectionSnapshot(db)).toEqual(snapshot);
    db.close();
  });

  it("retains contact and message identity after restart and later canonical observations", () => {
    const db = database();
    project(db, [message(lid)]);
    const before = db.orm().get<{ id: string }>(sql`SELECT id FROM messages`)!;
    const path = join(dirs[dirs.length - 1]!, "local.db");
    db.close();
    const reopened = new CuedDatabase(path);
    project(reopened, [alias(), contact(pn), message(pn)]);
    expect(reopened.orm().all(sql`SELECT id FROM contacts`)).toHaveLength(1);
    expect(reopened.orm().get<{ id: string }>(sql`SELECT id FROM messages`)?.id).toBe(before.id);
    const snapshot = readCanonicalProjectionSnapshot(reopened);
    rebuildProjectedState(reopened, { limit: 1 });
    expect(readCanonicalProjectionSnapshot(reopened)).toEqual(snapshot);
    reopened.close();
  });

  it("moves replies, participant memberships, reactions, calls, and cached attachment text to canonical rows", () => {
    const db = database();
    const conversation = (jid: string) =>
      event("conversation", "observed", {
        sourceConversationKey: source(jid),
        conversationType: "dm",
        participants: [{ sourceEntityKey: source(jid) }],
      });
    const reaction = (jid: string) =>
      event("reaction", "added", {
        sourceMessageKey: `${jid}:m`,
        sourceConversationKey: source(jid),
        reactorSourceKey: source(jid),
        emoji: "👍",
        timestamp: 1000,
        isActive: true,
      });
    const call = (jid: string) =>
      event("call", "observed", {
        sourceCallKey: `${jid}:call`,
        sourceConversationKey: source(jid),
        provider: "whatsapp",
        direction: "incoming",
        medium: "audio",
        status: "completed",
        startedAt: 1000,
        initiatorSourceKey: source(jid),
      });
    const reply = message(lid, "reply");
    (reply.payload as Record<string, unknown>).replyToSourceMessageKey = `${lid}:m`;
    project(db, [
      contact(pn),
      conversation(pn),
      message(pn),
      reaction(pn),
      call(pn),
      contact(lid),
      conversation(lid),
      message(lid),
      reaction(lid),
      call(lid),
      reply,
    ]);
    const oldAttachment = db
      .orm()
      .get<{ id: string }>(
        sql`SELECT id FROM message_attachments WHERE source_attachment_key = ${`${lid}:m:att`}`,
      )!;
    db.orm().run(
      sql`INSERT INTO attachment_content (attachment_id,status,text_content,created_at,updated_at) VALUES (${oldAttachment.id},'ready','searchable extraction',100,100)`,
    );
    project(db, [alias()]);
    expect(db.orm().all(sql`SELECT * FROM conversation_participants`)).toHaveLength(1);
    expect(db.orm().all(sql`SELECT * FROM message_reactions`)).toHaveLength(1);
    expect(db.orm().all(sql`SELECT * FROM timeline_events`)).toHaveLength(1);
    const canonicalMessage = db
      .orm()
      .get<{ id: string }>(sql`SELECT id FROM messages WHERE platform_message_id = ${`${pn}:m`}`)!;
    expect(
      db
        .orm()
        .get<{ reply_to_message_id: string }>(
          sql`SELECT reply_to_message_id FROM messages WHERE platform_message_id = ${`${pn}:reply`}`,
        )?.reply_to_message_id,
    ).toBe(canonicalMessage.id);
    expect(
      db
        .orm()
        .all(
          sql`SELECT * FROM attachment_content_fts WHERE attachment_content_fts MATCH 'searchable'`,
        ),
    ).toHaveLength(1);
    project(db, [reaction(lid), call(lid)]);
    expect(db.orm().all(sql`SELECT * FROM message_reactions`)).toHaveLength(1);
    expect(db.orm().all(sql`SELECT * FROM timeline_events`)).toHaveLength(1);
    expect(db.orm().all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    const snapshot = readCanonicalProjectionSnapshot(db);
    rebuildProjectedState(db, { limit: 1 });
    expect(readCanonicalProjectionSnapshot(db)).toEqual(snapshot);
    db.close();
  });

  it("rolls back all key and cache migrations when an alias event fails", () => {
    const db = database();
    project(db, [contact(pn), message(pn), contact(lid), message(lid)]);
    db.orm().run(
      sql.raw(
        "CREATE TRIGGER reject_alias BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'injected migration failure'); END",
      ),
    );
    db.insertRawEvents([alias()]);
    projectPendingRawEvents(db);
    expect(db.orm().all(sql`SELECT * FROM provider_identity_aliases`)).toEqual([]);
    expect(db.orm().all(sql`SELECT * FROM contacts`)).toHaveLength(2);
    expect(db.orm().all(sql`SELECT * FROM conversations`)).toHaveLength(2);
    db.orm().run(sql.raw("DROP TRIGGER reject_alias"));
    db.insertRawEvents([message(lid, "next")]);
    projectPendingRawEvents(db);
    expect(
      db
        .orm()
        .get<{ platform_message_id: string }>(
          sql`SELECT platform_message_id FROM messages WHERE platform_message_id = ${`${lid}:next`}`,
        )?.platform_message_id,
    ).toBe(`${lid}:next`);
    expect(db.orm().all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    db.close();
  });

  it("rejects conflicting mappings without changing existing identities", () => {
    const db = database();
    project(db, [alias()]);
    db.insertRawEvents([alias("a", "15550001111@s.whatsapp.net")]);
    projectPendingRawEvents(db);
    expect(
      db
        .orm()
        .get<{ canonical_source_key: string }>(
          sql`SELECT canonical_source_key FROM provider_identity_aliases`,
        )?.canonical_source_key,
    ).toBe(source(pn));
    expect(db.orm().all(sql`SELECT * FROM raw_event_projection_failures`)).toHaveLength(1);
    db.close();
  });
});

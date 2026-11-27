import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase, type RawEventInput } from "../../db/database.js";
import { projectPendingRawEvents } from "./projector.js";

/**
 * A sync re-observes conversations and contacts that have not changed all the time. Work
 * must follow what changed: a message arriving in a long conversation touches that message,
 * while a rename or a participant change still reaches every message that shows it.
 */
describe("projection write amplification", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "cued-write-amplification-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    let sequence = 0;
    const insert = (event: Omit<RawEventInput, "id" | "dedupeKey" | "observedAt" | "platform">) => {
      sequence += 1;
      db.insertRawEvent({
        ...event,
        id: `event-${sequence}`,
        dedupeKey: `event-${sequence}`,
        observedAt: sequence,
        platform: "imessage",
      } as RawEventInput);
    };
    const contact = (handle: string, displayName: string) =>
      insert({
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        sourceVersion: "test",
        payload: {
          sourceEntityKey: `imessage:${handle}`,
          fields: { display_name: displayName },
          handles: [{ type: "email", value: handle, deterministic: true }],
        },
      });
    const conversation = (
      key: string,
      displayName: string | null,
      handles: string[],
      conversationType: "dm" | "group" = "group",
    ) =>
      insert({
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        sourceVersion: "test",
        payload: {
          sourceConversationKey: key,
          conversationType,
          displayName,
          participants: handles.map((handle) => ({ sourceEntityKey: `imessage:${handle}` })),
        },
      });
    const message = (conversationKey: string, messageKey: string, sender: string | null) =>
      insert({
        accountKey: "local",
        entityKind: "message",
        eventKind: "created",
        sourceVersion: "test",
        payload: {
          sourceMessageKey: messageKey,
          sourceConversationKey: conversationKey,
          senderSourceKey: sender ? `imessage:${sender}` : null,
          sentAt: 1_700_000_000_000 + sequence,
          content: `synthetic body ${messageKey}`,
          isFromMe: sender == null,
        },
      });
    const timeline = (conversationKey: string, eventKey: string) =>
      insert({
        accountKey: "local",
        entityKind: "timeline_event",
        eventKind: "system_message",
        sourceVersion: "test",
        payload: {
          sourceEventKey: eventKey,
          sourceConversationKey: conversationKey,
          eventKind: "system_message",
          eventAt: 1_700_000_000_000 + sequence,
          text: "synthetic notice",
        },
      });
    const drain = () => {
      while (db.drainMessageFtsIndexQueue(500).claimed > 0) {
        // Index everything queued, including swept conversations.
      }
    };
    const queuedMessageIds = () =>
      db
        .orm()
        .all<{ message_id: string }>(
          sql`SELECT message_id FROM message_fts_index_queue ORDER BY message_id`,
        )
        .map((row) => row.message_id);
    const queuedConversations = () =>
      db
        .orm()
        .all<{ conversation_id: string }>(
          sql`SELECT conversation_id FROM message_fts_conversation_queue`,
        )
        .map((row) => row.conversation_id);
    const searchCount = (query: string) =>
      db
        .orm()
        .get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH ${query}`,
        )?.count ?? 0;
    const messageIdsFor = (messageKeys: string[]) =>
      db
        .orm()
        .all<{ id: string }>(
          sql`SELECT id FROM messages WHERE platform_message_id IN (${sql.join(
            messageKeys.map((key) => sql`${key}`),
            sql`, `,
          )}) ORDER BY id`,
        )
        .map((row) => row.id);
    /** Records every message row written from here on (a temp trigger on this connection). */
    const watchMessageWrites = () => {
      db.orm().run(sql`CREATE TEMP TABLE IF NOT EXISTS written_messages (id TEXT)`);
      db.orm().run(sql`DELETE FROM temp.written_messages`);
      db.orm().run(sql`
        CREATE TEMP TRIGGER IF NOT EXISTS record_message_writes AFTER UPDATE ON messages
        BEGIN
          INSERT INTO written_messages (id) VALUES (NEW.id);
        END
      `);
      return () =>
        db
          .orm()
          .all<{ id: string }>(sql`SELECT DISTINCT id FROM temp.written_messages ORDER BY id`)
          .map((row) => row.id);
    };
    return {
      db,
      contact,
      conversation,
      message,
      timeline,
      drain,
      queuedMessageIds,
      queuedConversations,
      searchCount,
      messageIdsFor,
      watchMessageWrites,
    };
  }

  const members = ["ava@example.com", "ben@example.com", "cal@example.com"];
  const memberNames = ["Ava Example", "Ben Example", "Cal Example"];

  function seedGroup(t: ReturnType<typeof setup>, messages: number) {
    members.forEach((member, index) => {
      t.contact(member, memberNames[index]!);
    });
    t.conversation("group-1", "Launch Crew", members);
    for (let index = 0; index < messages; index += 1) {
      t.message("group-1", `group-1-message-${index}`, members[index % 4] ?? null);
    }
    // A DM whose name comes from its participant: providers send no display name for it.
    t.contact("dee@example.com", "dee@example.com");
    t.conversation("dm-1", null, ["dee@example.com"], "dm");
    for (let index = 0; index < 20; index += 1) {
      t.message("dm-1", `dm-1-message-${index}`, index % 2 === 0 ? "dee@example.com" : null);
    }
    projectPendingRawEvents(t.db);
    t.drain();
  }

  it("re-indexes only the arriving messages when re-observed conversations did not change", () => {
    const t = setup();
    seedGroup(t, 300);
    const written = t.watchMessageWrites();

    // What an incremental sync stores when a message arrives in each conversation.
    members.forEach((member, index) => {
      t.contact(member, memberNames[index]!);
    });
    t.conversation("group-1", "Launch Crew", members);
    t.conversation("dm-1", null, ["dee@example.com"], "dm");
    t.timeline("group-1", "notice-1");
    t.message("group-1", "group-1-new", members[1]!);
    t.message("dm-1", "dm-1-new", "dee@example.com");
    projectPendingRawEvents(t.db);

    const arrived = t.messageIdsFor(["group-1-new", "dm-1-new"]);
    expect(t.queuedMessageIds()).toEqual(arrived);
    expect(t.queuedConversations()).toEqual([]);
    expect(written()).toEqual(arrived);
    expect(
      t.db
        .orm()
        .all<{ conversation_name: string | null; count: number }>(
          sql`SELECT conversation_name, COUNT(*) AS count FROM messages GROUP BY 1 ORDER BY 1`,
        ),
    ).toEqual([
      { conversation_name: "Launch Crew", count: 301 },
      { conversation_name: "dee@example.com", count: 21 },
    ]);
  });

  it("propagates a conversation rename to every message and to search", () => {
    const t = setup();
    seedGroup(t, 300);

    t.conversation("group-1", "Orbit Crew", members);
    projectPendingRawEvents(t.db);

    expect(t.queuedMessageIds()).toHaveLength(300);
    expect(
      t.db
        .orm()
        .all<{ conversation_name: string }>(
          sql`SELECT DISTINCT conversation_name FROM messages WHERE platform_message_id LIKE 'group-1-%'`,
        ),
    ).toEqual([{ conversation_name: "Orbit Crew" }]);
    t.drain();
    expect(t.searchCount("conversation_name:Orbit")).toBe(300);
    expect(t.searchCount("conversation_name:Launch")).toBe(0);
  });

  it("propagates a participant joining and a contact rename to search", () => {
    const t = setup();
    seedGroup(t, 300);

    t.contact("eve@example.com", "Eve Joiner");
    t.conversation("group-1", "Launch Crew", [...members, "eve@example.com"]);
    projectPendingRawEvents(t.db);
    t.drain();
    expect(t.searchCount("participant_names:Joiner")).toBe(300);

    t.contact(members[1]!, "Ben Renamed");
    projectPendingRawEvents(t.db);
    expect(
      t.db
        .orm()
        .all<{ sender_name: string }>(
          sql`SELECT DISTINCT m.sender_name FROM messages m JOIN contacts c ON c.id = m.sender_contact_id WHERE c.name = 'Ben Renamed'`,
        ),
    ).toEqual([{ sender_name: "Ben Renamed" }]);
    t.drain();
    // His 75 messages by sender, and all 300 through the participant list.
    expect(t.searchCount("sender_name:Renamed")).toBe(75);
    expect(t.searchCount("participant_names:Renamed")).toBe(300);
    expect(t.searchCount("Ben")).toBe(300);
  });

  it("hands a large conversation's rename to the search drain, which updates every message", () => {
    const t = setup();
    seedGroup(t, 2_100);

    t.conversation("group-1", "Orbit Crew", members);
    t.message("group-1", "group-1-new", members[0]!);
    projectPendingRawEvents(t.db);

    // Only the arriving message is rewritten inside the projection.
    expect(t.queuedMessageIds()).toEqual(t.messageIdsFor(["group-1-new"]));
    expect(t.queuedConversations()).toHaveLength(1);

    t.drain();
    expect(t.queuedConversations()).toEqual([]);
    expect(
      t.db
        .orm()
        .all<{ conversation_name: string; count: number }>(
          sql`SELECT conversation_name, COUNT(*) AS count FROM messages WHERE platform_message_id LIKE 'group-1-%' GROUP BY 1`,
        ),
    ).toEqual([{ conversation_name: "Orbit Crew", count: 2_101 }]);
    expect(t.searchCount("conversation_name:Orbit")).toBe(2_101);
    expect(t.searchCount("conversation_name:Launch")).toBe(0);
  });

  describe("one-to-one conversation names", () => {
    const conversationName = (t: ReturnType<typeof setup>, key: string) =>
      t.db
        .orm()
        .get<{ name: string | null; name_is_derived: number }>(
          sql`SELECT name, name_is_derived FROM conversations WHERE source_conversation_key = ${key}`,
        );
    const messageConversationNames = (t: ReturnType<typeof setup>, key: string) =>
      t.db
        .orm()
        .all<{ conversation_name: string | null; count: number }>(
          sql`SELECT conversation_name, COUNT(*) AS count FROM messages WHERE platform_message_id LIKE ${`${key}-%`} GROUP BY 1`,
        );

    function seedDms(t: ReturnType<typeof setup>, messages: number) {
      seedGroup(t, 30);
      t.contact("fay@example.com", "Fay Original");
      t.conversation("dm-fay", null, ["fay@example.com"], "dm");
      // A platform that names its one-to-one conversations, as an email thread is by its subject.
      t.conversation("dm-named", "Quarterly Planning", ["fay@example.com"], "dm");
      t.conversation("group-fay", "Fay Fans", ["fay@example.com", members[0]!]);
      for (const key of ["dm-fay", "dm-named", "group-fay"]) {
        for (let index = 0; index < messages; index += 1) {
          t.message(key, `${key}-${index}`, index % 2 === 0 ? "fay@example.com" : null);
        }
      }
      projectPendingRawEvents(t.db);
      t.drain();
    }

    it("follows a renamed contact in a name derived from the participant, and in search", () => {
      const t = setup();
      seedDms(t, 20);
      expect(conversationName(t, "dm-fay")).toEqual({ name: "Fay Original", name_is_derived: 1 });
      expect(t.searchCount("conversation_name:Original")).toBe(20);

      t.contact("fay@example.com", "Fay Renamed");
      projectPendingRawEvents(t.db);
      t.drain();

      expect(conversationName(t, "dm-fay")).toEqual({ name: "Fay Renamed", name_is_derived: 1 });
      expect(messageConversationNames(t, "dm-fay")).toEqual([
        { conversation_name: "Fay Renamed", count: 20 },
      ]);
      expect(t.searchCount("conversation_name:Renamed")).toBe(20);
      expect(t.searchCount("conversation_name:Original")).toBe(0);
    });

    it("keeps a platform-supplied one-to-one name and a group name when the contact is renamed", () => {
      const t = setup();
      seedDms(t, 20);

      t.contact("fay@example.com", "Fay Renamed");
      projectPendingRawEvents(t.db);
      t.drain();

      expect(conversationName(t, "dm-named")).toEqual({
        name: "Quarterly Planning",
        name_is_derived: 0,
      });
      expect(conversationName(t, "group-fay")).toEqual({ name: "Fay Fans", name_is_derived: 0 });
      expect(messageConversationNames(t, "dm-named")).toEqual([
        { conversation_name: "Quarterly Planning", count: 20 },
      ]);
      expect(t.searchCount("conversation_name:Quarterly")).toBe(20);
      expect(t.searchCount("conversation_name:Fans")).toBe(20);
      // The participant list follows the rename everywhere.
      expect(t.searchCount("participant_names:Renamed")).toBe(60);
    });

    it("hands a large one-to-one conversation's rename to the search drain", () => {
      const t = setup();
      seedDms(t, 600);

      t.contact("fay@example.com", "Fay Renamed");
      projectPendingRawEvents(t.db);
      expect(t.queuedConversations()).toHaveLength(3);
      t.drain();

      expect(messageConversationNames(t, "dm-fay")).toEqual([
        { conversation_name: "Fay Renamed", count: 600 },
      ]);
      expect(t.searchCount("conversation_name:Renamed")).toBe(600);
      expect(t.searchCount("conversation_name:Original")).toBe(0);
    });

    it("marks existing names when the column is added", () => {
      const t = setup();
      seedDms(t, 5);
      // Fay's conversation went stale before the migration: renamed, but the name kept.
      t.contact("dee@example.com", "Dee Renamed");
      projectPendingRawEvents(t.db);
      const raw = t.db.orm();
      raw.run(
        sql`UPDATE conversations SET name = 'Dee Stale' WHERE source_conversation_key = 'dm-1'`,
      );
      raw.run(sql`ALTER TABLE conversations DROP COLUMN name_is_derived`);
      raw.run(sql`DELETE FROM schema_migrations WHERE id = '0028_conversation_name_is_derived'`);
      t.db.migrate();

      expect(conversationName(t, "dm-fay")).toEqual({ name: "Fay Original", name_is_derived: 1 });
      expect(conversationName(t, "dm-named")?.name_is_derived).toBe(0);
      expect(conversationName(t, "group-fay")?.name_is_derived).toBe(0);
      // A name that no longer matches its participants cannot be told from a platform's...
      expect(conversationName(t, "dm-1")).toEqual({ name: "Dee Stale", name_is_derived: 0 });

      t.contact("fay@example.com", "Fay Renamed");
      projectPendingRawEvents(t.db);
      expect(conversationName(t, "dm-fay")?.name).toBe("Fay Renamed");
      expect(conversationName(t, "dm-named")?.name).toBe("Quarterly Planning");

      // ...until the platform next reports the conversation without a name of its own.
      t.conversation("dm-1", null, ["dee@example.com"], "dm");
      projectPendingRawEvents(t.db);
      expect(conversationName(t, "dm-1")).toEqual({ name: "Dee Renamed", name_is_derived: 1 });
    });
  });

  it("walks a queued conversation along an index", () => {
    const t = setup();
    const plan = t.db
      .orm()
      .all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN
          SELECT rowid, id, sent_at FROM messages
          WHERE conversation_id = 'c' AND (sent_at, rowid) > (1, 1)
          ORDER BY sent_at, rowid
          LIMIT 50`,
      )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_messages_conversation");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

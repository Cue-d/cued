import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { rebuildProjectedState } from "../projector/projector.js";
describe("projector", () => {
    const tempDirs = [];
    afterEach(() => {
        while (tempDirs.length > 0) {
            rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });
    function createDb() {
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
        const ftsRows = db.orm().all(sql `SELECT COUNT(*) as count FROM messages_fts`);
        expect(ftsRows[0]?.count).toBe(1);
        const contactsDirectory = db.orm().all(sql `
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
        const searchResults = db.orm().all(sql `
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
        const reactionRows = db.orm().all(sql `
      SELECT reaction_count
      FROM messages
    `);
        expect(reactionRows).toEqual([{ reaction_count: 1 }]);
        db.close();
    });
});
//# sourceMappingURL=projector.test.js.map
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentReplicaSyncBundle } from "../workers/agent-replica-worker-lib.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("agent replica worker", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createLegacyReplicaDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-agent-replica-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent-replica.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        company TEXT,
        notes TEXT,
        importance REAL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        handles_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        conversation_type TEXT NOT NULL,
        display_name TEXT,
        participant_contact_ids_json TEXT NOT NULL DEFAULT '[]',
        participant_names_json TEXT NOT NULL DEFAULT '[]',
        last_message_text TEXT,
        last_message_at INTEGER,
        unread_count INTEGER NOT NULL DEFAULT 0,
        user_participated INTEGER,
        workspace_id TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        conversation_name TEXT,
        platform TEXT NOT NULL,
        content TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        sender_contact_id TEXT,
        sender_name TEXT,
        is_from_me INTEGER NOT NULL,
        status TEXT,
        reactions_json TEXT
      );
    `);

    db.prepare(
      `INSERT INTO contacts (id, display_name, company, status, handles_json, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run(
      "contact-1",
      "Ava Chen",
      "Cued",
      JSON.stringify([
        { platform: "linkedin", type: "other", value: "ava-chen" },
        { platform: "imessage", type: "email", value: "ava@cued.com" },
      ]),
      Date.now(),
    );

    db.prepare(
      `INSERT INTO conversations (
         id, platform, platform_conversation_id, conversation_type, display_name,
         participant_contact_ids_json, participant_names_json, last_message_text, last_message_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "conv-1",
      "linkedin",
      "thread-1",
      "dm",
      "Ava Chen",
      JSON.stringify(["contact-1"]),
      JSON.stringify(["Ava Chen"]),
      "Founder update tomorrow?",
      1_710_000_000_000,
    );

    db.prepare(
      `INSERT INTO messages (
         id, conversation_id, conversation_name, platform, content, sent_at,
         sender_contact_id, sender_name, is_from_me, status, reactions_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-1",
      "conv-1",
      "Ava Chen",
      "linkedin",
      "Founder update tomorrow?",
      1_710_000_000_000,
      "contact-1",
      "Ava Chen",
      0,
      "delivered",
      JSON.stringify([{ emoji: "👍", isFromMe: false, timestamp: 1_710_000_000_500 }]),
    );

    db.close();
    return dbPath;
  }

  it("builds a sync bundle from the legacy replica schema", () => {
    const dbPath = createLegacyReplicaDb();
    const bundle = buildAgentReplicaSyncBundle({ path: dbPath, messageLimit: 10 });

    expect(bundle.sourceAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "linkedin" }),
        expect.objectContaining({ platform: "imessage" }),
      ]),
    );
    expect(bundle.rawEvents.some((event) => event.entityKind === "contact")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "reaction")).toBe(true);
  });
});

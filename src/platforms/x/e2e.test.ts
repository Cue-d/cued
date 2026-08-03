import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents } from "../../runtime/projection/projector.js";
import { buildXSyncBundle } from "./sync/bundle.js";

describe("X Birdclaw end to end", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads Birdclaw SQLite through the Go helper and projects searchable Cued data", async () => {
    const temp = mkdtempSync(join(tmpdir(), "cued-birdclaw-e2e-"));
    tempDirs.push(temp);
    const birdclawPath = join(temp, "birdclaw.sqlite");
    const cuedPath = join(temp, "cued.sqlite");
    const helperPath = join(temp, "cued-birdclaw-helper");
    const helperSource = resolve("native/helpers/birdclaw-go");
    execFileSync("go", ["build", "-o", helperPath, "."], {
      cwd: helperSource,
      env: { ...process.env, GOWORK: "off" },
    });

    const birdclaw = new Database(birdclawPath);
    birdclaw.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL,
        external_user_id TEXT, is_default INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT NOT NULL, bio TEXT NOT NULL,
        followers_count INTEGER NOT NULL, following_count INTEGER NOT NULL, avatar_url TEXT,
        location TEXT, url TEXT, verified_type TEXT
      );
      CREATE TABLE dm_conversations (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, participant_profile_id TEXT NOT NULL,
        title TEXT NOT NULL, last_message_at TEXT NOT NULL
      );
      CREATE TABLE dm_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_profile_id TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, direction TEXT NOT NULL
      );
      CREATE TABLE follow_edges (
        account_id TEXT NOT NULL, direction TEXT NOT NULL, profile_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL, source TEXT NOT NULL, current INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      INSERT INTO accounts VALUES ('acct-1', 'Sam', 'sam', '10', 1, '2026-01-01');
      INSERT INTO profiles VALUES (
        'profile-20', 'ava', 'Ava Chen', 'Robotics', 100, 80,
        'https://pbs.twimg.com/ava.jpg', 'New York', 'https://ava.example', 'blue'
      );
      INSERT INTO dm_conversations VALUES (
        '10-20', 'acct-1', 'profile-20', 'Ava Chen', '2026-08-03T12:00:00.000Z'
      );
      INSERT INTO dm_messages VALUES (
        'message-1', '10-20', 'profile-20', 'Hello from real SQLite',
        '2026-08-03T12:00:00.000Z', 'inbound'
      );
      INSERT INTO follow_edges VALUES
        ('acct-1', 'followers', 'profile-20', '20', 'archive', 1, '2026-01-01', '2026-08-01'),
        ('acct-1', 'following', 'profile-20', '20', 'archive', 1, '2026-01-01', '2026-08-01');
    `);
    birdclaw.close();

    const previousHelper = process.env.CUED_BIRDCLAW_HELPER_BINARY;
    const previousDatabase = process.env.CUED_BIRDCLAW_DB_PATH;
    process.env.CUED_BIRDCLAW_HELPER_BINARY = helperPath;
    process.env.CUED_BIRDCLAW_DB_PATH = birdclawPath;
    const bundle = await buildXSyncBundle();
    if (previousHelper === undefined) delete process.env.CUED_BIRDCLAW_HELPER_BINARY;
    else process.env.CUED_BIRDCLAW_HELPER_BINARY = previousHelper;
    if (previousDatabase === undefined) delete process.env.CUED_BIRDCLAW_DB_PATH;
    else process.env.CUED_BIRDCLAW_DB_PATH = previousDatabase;
    const cued = new CuedDatabase(cuedPath);
    try {
      cued.migrate();
      cued.upsertSourceAccounts(bundle.sourceAccounts ?? []);
      cued.insertRawEvents(bundle.rawEvents);
      const projection = projectPendingRawEvents(cued);
      expect(projection.appliedRawEvents).toBe(3);

      const sqlite = (
        cued as unknown as {
          sqlite: {
            prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> };
          };
        }
      ).sqlite;
      const contact = sqlite
        .prepare(`
          SELECT c.name, cs.metadata_json
          FROM contacts c JOIN contact_sources cs ON cs.contact_id = c.id
          WHERE cs.platform = 'x' AND cs.source_entity_key = 'x:user:20'
        `)
        .get() as { name: string; metadata_json: string };
      expect(contact.name).toBe("Ava Chen");
      expect(JSON.parse(contact.metadata_json)).toMatchObject({ mutual: true, followsYou: true });
      expect(
        sqlite.prepare("SELECT content FROM messages WHERE platform = 'x'").get(),
      ).toMatchObject({ content: "Hello from real SQLite" });
    } finally {
      cued.close();
    }
  }, 30_000);
});

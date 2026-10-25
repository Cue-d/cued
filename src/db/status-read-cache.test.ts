import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "./database.js";
import { openSqliteDatabase } from "./sqlite.js";
import { StatusReadCache } from "./status-read-cache.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cued-status-cache-"));
  directories.push(directory);
  const path = join(directory, "local.db");
  const db = openSqliteDatabase(path);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE daemon_state (heartbeat INTEGER)",
  );
  const cache = new StatusReadCache(db);
  let reads = 0;
  const count = () =>
    cache.read("items", () => {
      reads++;
      return (db.prepare("SELECT count(*) AS count FROM items").get() as { count: number }).count;
    });
  return { path, db, cache, count, reads: () => reads };
}

describe("status read cache", () => {
  it("reuses unchanged aggregates and invalidates own or external inserts, updates and deletes", () => {
    const { path, db, count, reads } = fixture();
    const other = openSqliteDatabase(path);
    try {
      expect(count()).toBe(0);
      expect(count()).toBe(0);
      expect(reads()).toBe(1);
      db.exec("INSERT INTO items VALUES(1)");
      expect(count()).toBe(1);
      other.exec("INSERT INTO items VALUES(2)");
      expect(count()).toBe(2);
      other.exec("DELETE FROM items WHERE id=1");
      expect(count()).toBe(1);
      db.exec("UPDATE items SET id=3");
      expect(count()).toBe(1);
      expect(reads()).toBe(5);
    } finally {
      other.close();
      db.close();
    }
  });

  it("never caches transaction-local values or reuses them after rollback", () => {
    const { db, count, reads } = fixture();
    try {
      expect(count()).toBe(0);
      expect(() =>
        db.transaction(() => {
          db.exec("INSERT INTO items VALUES(1)");
          expect(count()).toBe(1);
          throw new Error("rollback");
        })(),
      ).toThrow("rollback");
      expect(count()).toBe(0);
      expect(count()).toBe(0);
      expect(reads()).toBe(3);
      db.transaction(() => {
        db.exec("INSERT INTO items VALUES(2)");
        expect(count()).toBe(1);
      })();
      expect(count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("preserves heartbeat-only writes without hiding intervening data changes", () => {
    const { path, db, cache, count, reads } = fixture();
    const other = openSqliteDatabase(path);
    const heartbeat = () => db.exec("INSERT INTO daemon_state VALUES(1)");
    try {
      expect(count()).toBe(0);
      cache.preserveAcrossDaemonHeartbeat(heartbeat);
      expect(count()).toBe(0);
      expect(reads()).toBe(1);
      db.exec("INSERT INTO items VALUES(1)");
      cache.preserveAcrossDaemonHeartbeat(heartbeat);
      expect(count()).toBe(1);
      cache.preserveAcrossDaemonHeartbeat(() => {
        other.exec("INSERT INTO items VALUES(2)");
        heartbeat();
      });
      expect(count()).toBe(2);
      expect(reads()).toBe(3);
    } finally {
      other.close();
      db.close();
    }
  });

  it("does not expose mutable cached values", () => {
    const { db, cache } = fixture();
    try {
      const first = cache.read("array", () => [{ count: 1 }]);
      first[0]!.count = 42;
      expect(cache.read("array", () => [{ count: 9 }])).toEqual([{ count: 1 }]);
    } finally {
      db.close();
    }
  });

  it("refreshes real overview, integration and search counts across connections and rollback", () => {
    const directory = mkdtempSync(join(tmpdir(), "cued-status-integration-"));
    directories.push(directory);
    const path = join(directory, "local.db");
    const db = new CuedDatabase(path);
    db.migrate();
    const other = openSqliteDatabase(path);
    try {
      expect(db.getMenuBarOverview().messages).toBe(0);
      other.exec(`INSERT INTO conversations(id,platform,account_key,source_conversation_key,type,created_at,updated_at)
        VALUES('c','slack','a','c','dm',1,1);
        INSERT INTO messages(id,platform,account_key,platform_message_id,conversation_id,sent_at,created_at,updated_at)
        VALUES('m','slack','a','m','c',1,1,1);
        INSERT INTO message_fts_index_queue(message_id,reason,status,queued_at,updated_at)
        VALUES('m','test','queued',1,1)`);
      expect(db.getMenuBarOverview()).toMatchObject({
        messages: 1,
        integrationBreakdown: [{ platform: "slack", accountKey: "a", messages: 1, contacts: 0 }],
      });
      expect(db.getMessageFtsIndexBacklog().pending).toBe(1);
      other.exec("UPDATE message_fts_index_queue SET status='failed'");
      expect(db.getMessageFtsIndexBacklog()).toMatchObject({ pending: 0, failed: 1 });
      const readonly = new CuedDatabase(path, { readonly: true });
      try {
        expect(readonly.getOverview().messages).toBe(1);
      } finally {
        readonly.close();
      }
    } finally {
      other.close();
      db.close();
    }
  });
});

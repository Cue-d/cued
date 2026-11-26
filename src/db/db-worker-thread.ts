import { parentPort, workerData } from "node:worker_threads";
import type Database from "better-sqlite3-multiple-ciphers";
import type { CuedDatabase } from "./database.js";
import {
  type DbWorkerConnections,
  type DbWorkerRequest,
  type DbWorkerResponse,
  runDbWorkerJob,
} from "./db-worker-jobs.js";
import { openSqliteDatabase } from "./sqlite.js";

if (!parentPort) {
  throw new Error("db-worker-thread must run as a worker thread");
}
const port = parentPort;
const { dbPath } = workerData as { dbPath: string };

// Small page caches: this thread's work is index walks and short deletes, and every megabyte
// here is resident for as long as the thread lives.
const PAGE_CACHE_KIB = 4_000;
const BUSY_TIMEOUT_MS = 5_000;

const handles: Partial<Record<"read" | "write", Database.Database>> = {};
const databases: Partial<Record<"read" | "write", CuedDatabase>> = {};

const connections: DbWorkerConnections = {
  handle(connection) {
    const existing = handles[connection];
    if (existing) {
      return existing;
    }
    const sqlite = openSqliteDatabase(dbPath, { readonly: connection === "read" });
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.pragma(`cache_size = -${PAGE_CACHE_KIB}`);
    // Deleting a sync run must cascade to its errors.
    sqlite.pragma("foreign_keys = ON");
    if (connection === "write") {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
    }
    handles[connection] = sqlite;
    return sqlite;
  },
  async database(connection) {
    const existing = databases[connection];
    if (existing) {
      return existing;
    }
    // Loaded only when a job asks for it: this import brings the ORM with it.
    const { CuedDatabase: Database } = await import("./database.js");
    const database = new Database(dbPath, { readonly: connection === "read" });
    databases[connection] = database;
    return database;
  },
};

port.on("message", (request: DbWorkerRequest) => {
  void (async () => {
    let response: DbWorkerResponse;
    try {
      response = { id: request.id, ok: true, result: await runDbWorkerJob(connections, request) };
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    port.postMessage(response);
  })();
});

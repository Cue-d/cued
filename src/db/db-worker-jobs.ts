import type Database from "better-sqlite3-multiple-ciphers";
import type { IntegrationStatusOptions } from "../platforms/core/state/status.js";
import type { Platform } from "../platforms/core/types.js";
import type { CuedDatabase } from "./database.js";
import {
  checkpointWal,
  deleteSyncRunHistoryBatch,
  executeReadOnlySql,
  pruneSyncRunHistory,
  readStatusAggregates,
} from "./raw-queries.js";
import { drainSearchIndex } from "./search-index-drain.js";

/**
 * Database work the daemon runs on its worker thread instead of its own event loop.
 *
 * SQLite calls are synchronous, so anything slow on the daemon's thread stalls every request
 * behind it. A job here may take as long as it needs: it runs on a separate thread with its
 * own connections.
 *
 * Jobs come in two weights. The routine ones (`handle`) take a bare SQLite handle, so the
 * worker never has to load the ORM, which would cost a second isolate about 70 MB. The rare
 * ones behind a CLI command (`database`) get a full `CuedDatabase`, loaded on first use.
 *
 * Most jobs only read, on a read-only connection (WAL readers never block the daemon's
 * writes). The few that write keep each transaction to a few milliseconds and rest between
 * transactions, because a transaction holds the write lock the daemon's own writes need.
 */

/**
 * How long a background writer stays off the write lock after each transaction.
 *
 * SQLite has no queue for the write lock. A writer that finds it taken sleeps and retries, at
 * growing intervals (1, 2, 5, 10, 15 ms, ...), so a background job that starts its next
 * transaction the moment the last one commits can win the lock again and again while the
 * daemon's own write sleeps through every gap. Resting for as long as the longest of those
 * early retry intervals guarantees a waiting writer gets in on its next attempt.
 */
export const WRITE_LOCK_REST_MS = 15;

function restFromWriteLock(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WRITE_LOCK_REST_MS));
}

async function runDeleteBatches(
  options: { batchSize: number; maxBatches: number },
  deleteBatch: () => number,
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const count = deleteBatch();
    deleted += count;
    if (count < options.batchSize) {
      return { deleted, more: false };
    }
    await restFromWriteLock();
  }
  return { deleted, more: true };
}

/**
 * A BLOB column comes back as a Buffer, which serializes as `{type: "Buffer", data: [...]}`.
 * Crossing a thread boundary turns it into a plain typed array, which serializes as an object
 * of numbered keys. Convert before it crosses so `cued sql` output keeps its shape.
 */
function withJsonSafeBlobs(row: unknown): unknown {
  if (row == null || typeof row !== "object") {
    return row;
  }
  let converted: Record<string, unknown> | null = null;
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      converted ??= { ...(row as Record<string, unknown>) };
      converted[column] = { type: "Buffer", data: Array.from(value) };
    }
  }
  return converted ?? row;
}

type Connection = "read" | "write";

function handle<Args extends unknown[], Result>(
  connection: Connection,
  run: (sqlite: Database.Database, ...args: Args) => Result,
) {
  return { needs: "handle" as const, connection, run };
}

function database<Args extends unknown[], Result>(
  connection: Connection,
  run: (db: CuedDatabase, ...args: Args) => Result,
) {
  return { needs: "database" as const, connection, run };
}

export const DB_WORKER_JOBS = {
  /** Arbitrary read-only SQL from `cued sql`; an agent's query can run for seconds. */
  sql: handle("read", (sqlite, query: string) =>
    executeReadOnlySql(sqlite, query).map(withJsonSafeBlobs),
  ),
  /** The row counts status shows. Counting scans the largest tables. */
  statusAggregates: handle("read", (sqlite) => readStatusAggregates(sqlite)),
  /**
   * Moves committed WAL frames into the database file, so the daemon's own commits never have
   * to. Changes no data, but needs a writable connection.
   */
  checkpointWal: handle("write", (sqlite) => checkpointWal(sqlite)),
  /**
   * Deletes aged-out sync-run history, a short transaction per batch. Deleting from the
   * worker's connection also means its commits, not the daemon's, absorb the checkpoints that
   * a long backlog of deletes forces.
   */
  pruneSyncRunHistory: handle(
    "write",
    (sqlite, options: { batchSize: number; maxBatches: number }) =>
      runDeleteBatches(options, () => pruneSyncRunHistory(sqlite, { limit: options.batchSize })),
  ),
  /** Deletes a removed account's finished sync runs, a short transaction per batch. */
  purgeAccountSyncRunHistory: handle(
    "write",
    (
      sqlite,
      input: {
        platform: Platform;
        accountKey: string;
        queuedBefore: number;
        batchSize: number;
        maxBatches: number;
      },
    ) =>
      runDeleteBatches(input, () =>
        deleteSyncRunHistoryBatch(sqlite, {
          platform: input.platform,
          accountKey: input.accountKey,
          queuedBefore: input.queuedBefore,
          limit: input.batchSize,
        }),
      ),
  ),
  /**
   * Brings the message search index up to date for up to `budgetMs`, in short transactions
   * with a rest after each. Indexing makes FTS5 merge segments now and then, tens of
   * milliseconds that cannot be split, so it must not run on the daemon's thread.
   */
  indexMessageSearch: handle(
    "write",
    (sqlite, options: { budgetMs: number; staleBefore: number }) =>
      drainSearchIndex(sqlite, { ...options, restMs: WRITE_LOCK_REST_MS }),
  ),
  /** Contacts and Messages access, which can only be learned by spawning the native helper. */
  localAccess: handle("read", async () => {
    const [{ buildPermissionStatus }, { buildLocalIntegrationStates }] = await Promise.all([
      import("../runtime/doctor.js"),
      import("../platforms/core/state/local.js"),
    ]);
    return {
      permissions: (await buildPermissionStatus()).permissions,
      localIntegrationStates: buildLocalIntegrationStates(),
    };
  }),
  /** `cued integrations list`: per-account diagnostics for a person at a terminal. */
  integrationStatus: database("read", async (db, options: IntegrationStatusOptions) => {
    const { buildIntegrationStatus } = await import("../platforms/core/state/status.js");
    return buildIntegrationStatus(db, options);
  }),
  /** `cued status`, when no recent status snapshot can be reused. */
  daemonStatus: database(
    "read",
    async (
      db,
      options: Parameters<typeof import("../runtime/status.js").buildDaemonStatusSnapshot>[1],
    ) => {
      const { buildDaemonStatusSnapshot } = await import("../runtime/status.js");
      return buildDaemonStatusSnapshot(db, options);
    },
  ),
} as const;

export type DbWorkerJobName = keyof typeof DB_WORKER_JOBS;
type JobRun<Name extends DbWorkerJobName> = (typeof DB_WORKER_JOBS)[Name]["run"];
export type DbWorkerJobArgs<Name extends DbWorkerJobName> =
  // biome-ignore lint/suspicious/noExplicitAny: the first parameter is the connection, whose type varies by job.
  JobRun<Name> extends (connection: any, ...args: infer Args) => unknown ? Args : never;
export type DbWorkerJobResult<Name extends DbWorkerJobName> = Awaited<ReturnType<JobRun<Name>>>;
export type StatusAggregates = DbWorkerJobResult<"statusAggregates">;
export type LocalAccess = DbWorkerJobResult<"localAccess">;

export type DbWorkerRequest = { id: number; job: DbWorkerJobName; args: unknown[] };
export type DbWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** Where a job's connection comes from: a worker thread's own, or the caller's. */
export interface DbWorkerConnections {
  handle(connection: Connection): Database.Database;
  database(connection: Connection): CuedDatabase | Promise<CuedDatabase>;
}

export async function runDbWorkerJob(
  connections: DbWorkerConnections,
  request: DbWorkerRequest,
): Promise<unknown> {
  const job = DB_WORKER_JOBS[request.job] as
    | {
        needs: "handle" | "database";
        connection: Connection;
        run: (connection: never, ...args: unknown[]) => unknown;
      }
    | undefined;
  if (!job) {
    throw new Error(`Unknown database worker job: ${String(request.job)}`);
  }
  const connection =
    job.needs === "handle"
      ? connections.handle(job.connection)
      : await connections.database(job.connection);
  return await job.run(connection as never, ...request.args);
}

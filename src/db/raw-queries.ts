/**
 * Queries that need nothing but a SQLite handle.
 *
 * The database worker thread runs these, and it must stay light: loading the ORM into a second
 * isolate costs about 70 MB. Anything here can be called with a bare better-sqlite3 handle, and
 * `CuedDatabase` delegates to the same functions so there is one definition of each query.
 */
import type Database from "better-sqlite3-multiple-ciphers";
import type { Platform } from "../core/types/provider.js";

export const SYNC_RUN_COMPLETED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const SYNC_RUN_FAILED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface IntegrationProjectionCount {
  platform: Platform;
  accountKey: string;
  contacts: number;
  messages: number;
}

export interface MenuBarOverview {
  contacts: number;
  conversations: number;
  messages: number;
  rawEvents: number;
  sourceAccounts: number;
  integrations: number;
  authSessions: number;
  messageBreakdown: Array<{ platform: Platform; messages: number }>;
  integrationBreakdown: IntegrationProjectionCount[];
}

export interface MessageFtsIndexBacklog {
  queued: number;
  indexing: number;
  failed: number;
  pending: number;
}

export function executeReadOnlySql(sqlite: Database.Database, query: string): unknown[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("SQL query must not be empty");
  }
  if (!/^(select|with|pragma|explain)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT/PRAGMA/EXPLAIN queries are supported");
  }
  const statement = sqlite.prepare(trimmed) as Database.Statement & { reader?: boolean };
  if (statement.reader === false) {
    throw new Error("Only read-only queries are supported");
  }
  return statement.all();
}

type CountedTable =
  | "contacts"
  | "conversations"
  | "raw_events"
  | "source_accounts"
  | "integration_states"
  | "auth_sessions";

function countRows(sqlite: Database.Database, table: CountedTable): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number | null }
    | undefined;
  return Number(row?.count ?? 0);
}

export function readProjectionCountsByIntegration(
  sqlite: Database.Database,
): IntegrationProjectionCount[] {
  const byIntegration = new Map<string, IntegrationProjectionCount>();
  const getOrCreate = (platform: Platform, accountKey: string) => {
    const key = `${platform}\u0000${accountKey}`;
    const existing = byIntegration.get(key);
    if (existing) {
      return existing;
    }
    const created = { platform, accountKey, contacts: 0, messages: 0 };
    byIntegration.set(key, created);
    return created;
  };
  type CountRow = { platform: Platform; account_key: string; count: number | null };
  const contactCounts = sqlite
    .prepare(
      `SELECT platform, account_key, COUNT(*) AS count
       FROM contact_sources
       GROUP BY platform, account_key`,
    )
    .all() as CountRow[];
  for (const row of contactCounts) {
    getOrCreate(row.platform, row.account_key).contacts = Number(row.count ?? 0);
  }
  const messageCounts = sqlite
    .prepare(
      `SELECT platform, account_key, COUNT(*) AS count
       FROM messages
       GROUP BY platform, account_key`,
    )
    .all() as CountRow[];
  for (const row of messageCounts) {
    getOrCreate(row.platform, row.account_key).messages = Number(row.count ?? 0);
  }
  return [...byIntegration.values()];
}

export function readMenuBarOverview(
  sqlite: Database.Database,
  integrationBreakdown: IntegrationProjectionCount[] = readProjectionCountsByIntegration(sqlite),
): MenuBarOverview {
  const messagesByPlatform = new Map<Platform, number>();
  for (const row of integrationBreakdown) {
    messagesByPlatform.set(
      row.platform,
      (messagesByPlatform.get(row.platform) ?? 0) + row.messages,
    );
  }
  const messageBreakdown = [...messagesByPlatform]
    .map(([platform, messages]) => ({ platform, messages }))
    .sort(
      (left, right) =>
        right.messages - left.messages || left.platform.localeCompare(right.platform),
    );
  return {
    contacts: countRows(sqlite, "contacts"),
    conversations: countRows(sqlite, "conversations"),
    messages: messageBreakdown.reduce((total, row) => total + row.messages, 0),
    rawEvents: countRows(sqlite, "raw_events"),
    sourceAccounts: countRows(sqlite, "source_accounts"),
    integrations: countRows(sqlite, "integration_states"),
    authSessions: countRows(sqlite, "auth_sessions"),
    messageBreakdown,
    integrationBreakdown,
  };
}

export function countObservedPhoneCalls(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS calls
       FROM raw_events
       WHERE platform = 'imessage'
         AND account_key = 'local'
         AND COALESCE(normalized_schema, entity_kind || '.' || event_kind || '@1') = 'call.observed@1'`,
    )
    .get() as { calls: number | null };
  return Number(row.calls ?? 0);
}

export function readMessageFtsIndexBacklog(sqlite: Database.Database): MessageFtsIndexBacklog {
  const rows = sqlite
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM message_fts_index_queue
       GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;
  const counts = { queued: 0, indexing: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "queued" || row.status === "indexing" || row.status === "failed") {
      counts[row.status] = Number(row.count ?? 0);
    }
  }
  return { ...counts, pending: counts.queued + counts.indexing };
}

export function readStatusAggregates(sqlite: Database.Database): {
  overview: MenuBarOverview;
  phoneCalls: number;
  searchIndex: MessageFtsIndexBacklog;
} {
  return {
    overview: readMenuBarOverview(sqlite),
    phoneCalls: countObservedPhoneCalls(sqlite),
    searchIndex: readMessageFtsIndexBacklog(sqlite),
  };
}

/**
 * Deletes one bounded batch of finished sync runs that have aged out of retention. The newest
 * finished run of every known account is always kept so status can still report the last
 * sync. Returns the number of runs deleted; a result below `limit` means nothing is left to
 * prune right now.
 */
export function pruneSyncRunHistory(
  sqlite: Database.Database,
  options: {
    limit: number;
    nowMs?: number;
    completedRetentionMs?: number;
    failedRetentionMs?: number;
  },
): number {
  const nowMs = options.nowMs ?? Date.now();
  const completedCutoff = nowMs - (options.completedRetentionMs ?? SYNC_RUN_COMPLETED_RETENTION_MS);
  const failedCutoff = nowMs - (options.failedRetentionMs ?? SYNC_RUN_FAILED_RETENTION_MS);
  return sqlite
    .transaction(() => {
      const keepIds = (
        sqlite
          .prepare(
            `SELECT (
               SELECT run.id FROM sync_runs run
               WHERE run.platform = account.platform
                 AND run.account_key = account.account_key
                 AND run.finished_at IS NOT NULL
               ORDER BY run.finished_at DESC
               LIMIT 1
             ) AS id
             FROM (
               SELECT platform, account_key FROM integration_states
               UNION SELECT platform, account_key FROM sync_checkpoints
               UNION SELECT platform, account_key FROM source_accounts
             ) account`,
          )
          .all() as Array<{ id: string | null }>
      )
        .map((row) => row.id)
        .filter((id): id is string => id != null);
      return sqlite
        .prepare(
          `DELETE FROM sync_runs WHERE rowid IN (
             SELECT rowid FROM sync_runs
             WHERE queued_at < ?
               AND CASE status
                     WHEN 'completed' THEN queued_at < ?
                     WHEN 'failed' THEN queued_at < ?
                     ELSE 0
                   END
               AND id NOT IN (SELECT value FROM json_each(?))
             ORDER BY queued_at ASC
             LIMIT ?
           )`,
        )
        .run(
          // The leading bound is what walks idx_sync_runs_queued_at oldest-first. The status
          // rule is a CASE, not an OR of indexable terms, so the planner cannot swap that walk
          // for a status-index scan plus a sort of every finished run.
          Math.max(completedCutoff, failedCutoff),
          completedCutoff,
          failedCutoff,
          JSON.stringify(keepIds),
          Math.max(1, Math.trunc(options.limit)),
        ).changes;
      // Reads before it writes: take the write lock up front, because SQLite refuses to
      // upgrade a read transaction if another connection committed in between.
    })
    .immediate();
}

/**
 * Deletes one bounded batch of an account's finished sync runs queued before `queuedBefore`
 * (their errors cascade). Returns the number of runs deleted.
 */
export function deleteSyncRunHistoryBatch(
  sqlite: Database.Database,
  input: { platform: Platform; accountKey: string; queuedBefore: number; limit: number },
): number {
  return sqlite
    .prepare(
      `DELETE FROM sync_runs WHERE rowid IN (
         SELECT rowid FROM sync_runs
         WHERE platform = ? AND account_key = ?
           AND status IN ('completed', 'failed')
           AND queued_at < ?
         LIMIT ?
       )`,
    )
    .run(input.platform, input.accountKey, input.queuedBefore, Math.max(1, Math.trunc(input.limit)))
    .changes;
}

/**
 * Moves committed WAL frames into the database file without blocking readers or writers.
 * Changes no data. Returns how many WAL frames exist and how many are now checkpointed.
 */
export function checkpointWal(sqlite: Database.Database): {
  walFrames: number;
  checkpointedFrames: number;
} {
  const [result] = sqlite.pragma("wal_checkpoint(PASSIVE)") as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  return { walFrames: result?.log ?? 0, checkpointedFrames: result?.checkpointed ?? 0 };
}

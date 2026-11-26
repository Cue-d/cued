import type Database from "better-sqlite3-multiple-ciphers";
import { refreshMessageNamesStatement } from "./message-names.js";

/**
 * Keeps the message search index (`messages_fts`) up to date, on the database worker thread.
 *
 * Two queues feed it. `message_fts_index_queue` names single messages whose search document
 * changed. `message_fts_conversation_queue` names whole conversations whose every message
 * must have its names re-derived and its document rebuilt (a rename, a participant change):
 * those can hold a hundred thousand messages, so they are worked through a slice at a time,
 * with a cursor.
 *
 * Indexing cannot be cut into pieces of a few milliseconds: every so often a write makes
 * FTS5 merge index segments, which takes tens of milliseconds whatever the transaction's
 * size. That is why this runs off the daemon's thread. Each transaction is still kept short,
 * and the worker rests after each one, so the daemon's own writes never wait long for the
 * write lock.
 */

export type SearchIndexDrainOptions = {
  /** Stop starting new transactions after this long, so the caller hears back regularly. */
  budgetMs: number;
  /** Rows a previous build left `indexing` before this time are queued again. */
  staleBefore: number;
  /** Rest between transactions; see WRITE_LOCK_REST_MS. */
  restMs: number;
  /** Starting size of a transaction; it adapts toward `targetTransactionMs`. */
  initialMessages?: number;
  targetTransactionMs?: number;
};

export type SearchIndexDrainResult = {
  claimed: number;
  indexed: number;
  failed: number;
  /** Messages of queued conversations re-derived and re-indexed. */
  swept: number;
  drained: boolean;
};

const MAX_TRANSACTION_MESSAGES = 200;
const DEFAULT_TARGET_TRANSACTION_MS = 5;
const DEFAULT_INITIAL_MESSAGES = 20;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function replaceSearchDocuments(sqlite: Database.Database, messageIds: string[]): number {
  const list = placeholders(messageIds.length);
  sqlite
    .prepare(
      `DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN (${list}))`,
    )
    .run(...messageIds);
  return sqlite
    .prepare(
      `INSERT INTO messages_fts (
         rowid, message_id, sender_name, conversation_name, participant_names, attachment_text,
         content
       )
       SELECT message_rowid, message_id, sender_name, conversation_name, participant_names,
         attachment_text, content
       FROM message_fts_source
       WHERE message_id IN (${list})`,
    )
    .run(...messageIds).changes;
}

/** Indexes up to `limit` queued messages and removes them from the queue, in one transaction. */
export function indexQueuedMessages(
  sqlite: Database.Database,
  limit: number,
): { claimed: number; indexed: number; failed: number } {
  let messageIds: string[] = [];
  try {
    return sqlite
      .transaction(() => {
        messageIds = sqlite
          .prepare(
            `SELECT message_id FROM message_fts_index_queue
             WHERE status = 'queued'
             ORDER BY queued_at
             LIMIT ?`,
          )
          .pluck()
          .all(limit) as string[];
        if (messageIds.length === 0) {
          return { claimed: 0, indexed: 0, failed: 0 };
        }
        const indexed = replaceSearchDocuments(sqlite, messageIds);
        sqlite
          .prepare(
            `DELETE FROM message_fts_index_queue WHERE message_id IN (${placeholders(messageIds.length)})`,
          )
          .run(...messageIds);
        return { claimed: messageIds.length, indexed, failed: 0 };
      })
      .immediate();
  } catch (error) {
    if (messageIds.length === 0 || isBusy(error)) {
      throw error;
    }
    // Keep a message that cannot be indexed from blocking the rest of the queue.
    sqlite
      .prepare(
        `UPDATE message_fts_index_queue
         SET status = 'failed', attempt = attempt + 1, updated_at = ?, last_error = ?
         WHERE message_id IN (${placeholders(messageIds.length)})`,
      )
      .run(Date.now(), error instanceof Error ? error.message : String(error), ...messageIds);
    return { claimed: messageIds.length, indexed: 0, failed: messageIds.length };
  }
}

/**
 * Re-derives the names of the next `limit` messages of the oldest queued conversation and
 * rebuilds their search documents, in one transaction. Returns how many it did, or null when
 * no conversation is queued.
 */
export function sweepQueuedConversation(sqlite: Database.Database, limit: number): number | null {
  return sqlite
    .transaction(() => {
      const entry = sqlite
        .prepare(
          `SELECT conversation_id, after_sent_at, after_rowid
           FROM message_fts_conversation_queue
           ORDER BY queued_at, conversation_id
           LIMIT 1`,
        )
        .get() as
        | { conversation_id: string; after_sent_at: number | null; after_rowid: number | null }
        | undefined;
      if (!entry) {
        return null;
      }
      // Walks idx_messages_conversation (conversation_id, sent_at), whose entries are in
      // (sent_at, rowid) order, so each slice starts where the last one stopped.
      const rows = (
        entry.after_rowid == null
          ? sqlite
              .prepare(
                `SELECT rowid, id, sent_at FROM messages
                 WHERE conversation_id = ?
                 ORDER BY sent_at, rowid
                 LIMIT ?`,
              )
              .all(entry.conversation_id, limit)
          : sqlite
              .prepare(
                `SELECT rowid, id, sent_at FROM messages
                 WHERE conversation_id = ? AND (sent_at, rowid) > (?, ?)
                 ORDER BY sent_at, rowid
                 LIMIT ?`,
              )
              .all(entry.conversation_id, entry.after_sent_at, entry.after_rowid, limit)
      ) as Array<{ rowid: number; id: string; sent_at: number }>;
      if (rows.length > 0) {
        const messageIds = rows.map((row) => row.id);
        sqlite
          .prepare(refreshMessageNamesStatement(`id IN (${placeholders(messageIds.length)})`))
          .all(...messageIds);
        replaceSearchDocuments(sqlite, messageIds);
      }
      const last = rows.at(-1);
      if (rows.length < limit || !last) {
        sqlite
          .prepare("DELETE FROM message_fts_conversation_queue WHERE conversation_id = ?")
          .run(entry.conversation_id);
      } else {
        sqlite
          .prepare(
            `UPDATE message_fts_conversation_queue
             SET after_sent_at = ?, after_rowid = ?, updated_at = ?
             WHERE conversation_id = ?`,
          )
          .run(last.sent_at, last.rowid, Date.now(), entry.conversation_id);
      }
      return rows.length;
    })
    .immediate();
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite_(busy|locked)|database is locked|database is busy/i.test(message);
}

/**
 * Works through both queues for up to `budgetMs`, in short transactions with a rest after
 * each. Single messages go first, so a message that just arrived is searchable before a
 * rename's backlog is.
 */
export async function drainSearchIndex(
  sqlite: Database.Database,
  options: SearchIndexDrainOptions,
): Promise<SearchIndexDrainResult> {
  const startedAt = performance.now();
  const targetMs = options.targetTransactionMs ?? DEFAULT_TARGET_TRANSACTION_MS;
  const result: SearchIndexDrainResult = {
    claimed: 0,
    indexed: 0,
    failed: 0,
    swept: 0,
    drained: false,
  };
  sqlite
    .prepare(
      `UPDATE message_fts_index_queue
       SET status = 'queued', updated_at = ?, last_error = NULL
       WHERE status = 'indexing' AND updated_at < ?`,
    )
    .run(Date.now(), options.staleBefore);
  let messages = options.initialMessages ?? DEFAULT_INITIAL_MESSAGES;
  while (performance.now() - startedAt < options.budgetMs) {
    const transactionStartedAt = performance.now();
    const batch = indexQueuedMessages(sqlite, messages);
    result.claimed += batch.claimed;
    result.indexed += batch.indexed;
    result.failed += batch.failed;
    if (batch.claimed === 0) {
      const swept = sweepQueuedConversation(sqlite, messages);
      if (swept == null) {
        result.drained = true;
        break;
      }
      result.swept += swept;
    }
    // Size the next transaction toward the target; it varies with what the messages hold.
    const elapsedMs = performance.now() - transactionStartedAt;
    const scaled = elapsedMs > 0 ? (messages * targetMs) / elapsedMs : messages * 2;
    messages = Math.max(1, Math.min(MAX_TRANSACTION_MESSAGES, messages * 2, Math.round(scaled)));
    await new Promise((resolve) => setTimeout(resolve, options.restMs));
  }
  return result;
}

/**
 * A long-lived conversation for the responsiveness benchmark.
 *
 * Real installs have conversations with a hundred thousand messages, and a single message
 * arriving in one used to rewrite and re-index all of them. The fixture seeds one such group
 * chat through the real iMessage sync and projector (so its contacts, participants and names
 * are exactly what a real sync leaves behind), then fills in the history in bulk. The
 * scenarios serve further iMessage batches through the fake native helper, so a benchmark
 * sync takes the same path a real one does: adapter, raw events, projection worker, search
 * index queue.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import type { CuedDatabase } from "../../db/database.js";
import type {
  ImsChat,
  ImsHandle,
  ImsMessage,
  ImsSyncBatch,
} from "../../platforms/imessage/types.js";

const LARGE_CONVERSATION_MESSAGES = 110_000;
/** chat.db ROWID of the large chat and of the first message the scenarios deliver. */
const LARGE_CHAT_ID = 900_001;
const FIRST_SCENARIO_ROWID = 5_000_000;
const LARGE_CHAT_HANDLES: ImsHandle[] = [
  { id: 900_101, identifier: "perf-large-a@example.com", service: "iMessage" },
  { id: 900_102, identifier: "perf-large-b@example.com", service: "iMessage" },
  { id: 900_103, identifier: "perf-large-c@example.com", service: "iMessage" },
];
const LARGE_CHAT_NAME = "Perf Large Group";
const MESSAGE_TEXT = "Synthetic message in the large benchmark conversation.";

/** Env var the fake native helper reads the iMessage batch to serve from. */
export const IMESSAGE_BATCH_ENV = "CUED_PERF_IMESSAGE_BATCH";
const EMPTY_IMESSAGE_BATCH: ImsSyncBatch = {
  cursor: 0,
  fetchedCount: 0,
  chats: [],
  messages: [],
  handles: [],
};

/**
 * Shell lines for the fake native helper: `imessage dump` serves the batch file named by
 * CUED_PERF_IMESSAGE_BATCH (or an empty batch), `callhistory dump` serves no calls.
 */
export const FAKE_HELPER_IMESSAGE_LINES = `if [ "$1" = "imessage" ] && [ "$2" = "dump" ]; then
  if [ -n "$${IMESSAGE_BATCH_ENV}" ] && [ -f "$${IMESSAGE_BATCH_ENV}" ]; then
    cat "$${IMESSAGE_BATCH_ENV}"
  else
    echo '${JSON.stringify(EMPTY_IMESSAGE_BATCH)}'
  fi
  exit 0
fi
if [ "$1" = "callhistory" ] && [ "$2" = "dump" ]; then
  echo '{"cursor":0,"fetchedCount":0,"calls":[]}'
  exit 0
fi
`;

function largeChat(displayName: string): ImsChat {
  return {
    id: LARGE_CHAT_ID,
    identifier: `chat${LARGE_CHAT_ID}`,
    displayName,
    isGroup: true,
    participants: LARGE_CHAT_HANDLES,
  };
}

function largeChatMessage(rowid: number, options: { itemType?: number } = {}): ImsMessage {
  const sender = LARGE_CHAT_HANDLES[rowid % (LARGE_CHAT_HANDLES.length + 1)] ?? null;
  return {
    id: rowid,
    guid: `perf-large-guid-${rowid}`,
    chatId: LARGE_CHAT_ID,
    itemType: options.itemType ?? 0,
    text: options.itemType ? null : `${MESSAGE_TEXT} ${rowid}`,
    timestamp: Math.floor(Date.now() / 1000),
    isFromMe: sender == null,
    isRead: true,
    readAt: null,
    status: sender == null ? "sent" : "delivered",
    errorCode: 0,
    hasAttachments: false,
    attachments: [],
    sender,
    reactions: [],
  };
}

function batch(rowids: number[], displayName: string, itemType?: number): ImsSyncBatch {
  return {
    cursor: rowids.at(-1) ?? 0,
    fetchedCount: rowids.length,
    chats: [largeChat(displayName)],
    messages: rowids.map((rowid) => largeChatMessage(rowid, { itemType })),
    handles: LARGE_CHAT_HANDLES,
  };
}

let nextScenarioRowid = FIRST_SCENARIO_ROWID;

/** A batch of `count` ordinary messages arriving in the large chat. */
export function largeConversationDeliveryBatch(count: number): ImsSyncBatch {
  const rowids = Array.from({ length: count }, () => nextScenarioRowid++);
  return batch(rowids, LARGE_CHAT_NAME);
}

/** The large chat renamed: one group-name-change item, and the chat's new display name. */
export function largeConversationRenameBatch(): ImsSyncBatch {
  return batch([nextScenarioRowid++], `${LARGE_CHAT_NAME} (renamed)`, 2);
}

/**
 * Seeds the large chat through the real iMessage adapter and projector, then bulk-inserts
 * the rest of its history as copies of the projected seed messages.
 */
export async function seedLargeConversation(input: {
  db: CuedDatabase;
  workDir: string;
  scale: number;
}): Promise<void> {
  const { buildIMessageSyncBundle } = await import("../../platforms/imessage/sync.js");
  const { projectPendingRawEvents } = await import("../projection/projector.js");
  const seedDir = mkdtempSync(join(input.workDir, "seed-"));
  try {
    const helperPath = join(seedDir, "helper");
    const batchPath = join(seedDir, "batch.json");
    // One message per sender (and one from me), so every name the history needs is projected.
    writeFileSync(batchPath, JSON.stringify(batch([1, 2, 3, 4], LARGE_CHAT_NAME)));
    writeFileSync(helperPath, `#!/bin/sh\n${FAKE_HELPER_IMESSAGE_LINES}exit 1\n`);
    chmodSync(helperPath, 0o755);
    // The helper inherits this process's environment, not the one the loader is given.
    const previousBatch = process.env[IMESSAGE_BATCH_ENV];
    process.env[IMESSAGE_BATCH_ENV] = batchPath;
    let bundle: ReturnType<typeof buildIMessageSyncBundle>;
    try {
      bundle = buildIMessageSyncBundle({
        path: join(seedDir, "chat.db"),
        env: { CUED_IMESSAGE_NATIVE_BINARY: helperPath },
      });
    } finally {
      if (previousBatch === undefined) {
        delete process.env[IMESSAGE_BATCH_ENV];
      } else {
        process.env[IMESSAGE_BATCH_ENV] = previousBatch;
      }
    }
    input.db.insertRawEvents(bundle.rawEvents);
    projectPendingRawEvents(input.db);
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
}

/** Fills the large chat's history; call after the seed has been projected. */
export function fillLargeConversation(sqlite: Database.Database, scale: number): number {
  const templates = sqlite
    .prepare(
      `SELECT platform, account_key, conversation_id, sender_contact_id, sender_source_key,
         sender_name, conversation_name, service, status, is_from_me
       FROM messages
       WHERE platform = 'imessage' AND platform_message_id LIKE 'perf-large-guid-%'
       ORDER BY platform_message_id`,
    )
    .all() as Array<Record<string, unknown>>;
  if (templates.length === 0) {
    throw new Error("Large conversation seed did not project");
  }
  // The history has been read, as a real chat's has (Messages records when each was read),
  // so the chat's unread count covers only what the scenarios deliver.
  const insert = sqlite.prepare(
    `INSERT INTO messages (id, platform, account_key, platform_message_id, conversation_id,
       sender_contact_id, sender_source_key, sender_name, conversation_name, sent_at, service,
       status, is_from_me, content, read_at, is_deleted, is_edited, attachment_count,
       reaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
  );
  const total = Math.max(1, Math.round(LARGE_CONVERSATION_MESSAGES * scale));
  const nowMs = Date.now();
  sqlite.transaction(() => {
    for (let index = 0; index < total; index += 1) {
      const template = templates[index % templates.length]!;
      const sentAt = nowMs - (total - index) * 60_000;
      insert.run(
        `perf-large-message-${index}`,
        template.platform,
        template.account_key,
        `perf-large-history-${index}`,
        template.conversation_id,
        template.sender_contact_id,
        template.sender_source_key,
        template.sender_name,
        template.conversation_name,
        sentAt,
        template.service,
        template.status,
        template.is_from_me,
        `${MESSAGE_TEXT} history ${index}`,
        sentAt + 60_000,
        sentAt,
        sentAt,
      );
    }
  })();
  return total;
}

/**
 * Counts rows the projector queues for search re-indexing, so a scenario can report how
 * many messages a sync made the daemon re-index. Installed on the benchmark's private copy.
 */
export const SEARCH_REINDEX_COUNTER_SQL = `
  CREATE TABLE IF NOT EXISTS perf_search_reindex_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    queued INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO perf_search_reindex_counter (id, queued) VALUES (1, 0);
  CREATE TRIGGER IF NOT EXISTS perf_search_reindex_inserted
  AFTER INSERT ON message_fts_index_queue
  WHEN NEW.reason LIKE 'projection:%'
  BEGIN
    UPDATE perf_search_reindex_counter SET queued = queued + 1 WHERE id = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS perf_search_reindex_requeued
  AFTER UPDATE OF reason, status ON message_fts_index_queue
  WHEN NEW.status = 'queued' AND NEW.reason LIKE 'projection:%' AND OLD.status <> 'queued'
  BEGIN
    UPDATE perf_search_reindex_counter SET queued = queued + 1 WHERE id = 1;
  END;
`;

/** Samples the peak resident memory of the daemon's projection worker processes. */
export class ProjectionWorkerMemorySampler {
  peakRssBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;

  /** Only children of this daemon count: a real Cued app may be running on the machine. */
  constructor(private readonly daemonPid: number) {}

  start(): void {
    this.timer = setInterval(() => void this.sample(), 50);
  }

  private async sample(): Promise<void> {
    if (this.sampling) {
      return;
    }
    this.sampling = true;
    try {
      const output = await new Promise<string>((resolveOutput) => {
        const child = spawn("ps", ["-ax", "-o", "ppid=,rss=,command="], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let text = "";
        child.stdout.on("data", (chunk) => {
          text += chunk.toString("utf8");
        });
        child.once("close", () => resolveOutput(text));
        child.once("error", () => resolveOutput(""));
      });
      for (const line of output.split("\n")) {
        if (!line.includes("__projection-worker")) {
          continue;
        }
        const [ppid, rss] = line.trim().split(/\s+/, 2);
        const rssKb = Number(rss);
        if (Number(ppid) === this.daemonPid && Number.isFinite(rssKb)) {
          this.peakRssBytes = Math.max(this.peakRssBytes, rssKb * 1024);
        }
      }
    } finally {
      this.sampling = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

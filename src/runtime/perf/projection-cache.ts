/** Run with: pnpm exec tsx src/runtime/perf/projection-cache.ts [conversation-count] [event-count] */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents } from "../projection/projector.js";

const conversationCount = Number(process.argv[2] ?? 10_000);
const eventCount = Number(process.argv[3] ?? 200);
if (![conversationCount, eventCount].every((n) => Number.isSafeInteger(n) && n > 0)) {
  throw new Error("Counts must be positive integers");
}
const dir = mkdtempSync(join(tmpdir(), "cued-projection-cache-bench-"));
const db = new CuedDatabase(join(dir, "local.db"));
try {
  db.migrate();
  db.orm().transaction((tx) => {
    for (let i = 0; i < conversationCount; i++) {
      tx.run(sql`INSERT INTO conversations (id, platform, account_key, source_conversation_key,
        type, name, created_at, updated_at)
        VALUES (${`conversation-${i}`}, 'slack', 'default', ${`thread-${i}`}, 'dm', ${`Thread ${i}`}, 1, 1)`);
    }
  });
  const samples = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    for (let i = 0; i < eventCount; i++) {
      const id = `message-${iteration}-${i}`;
      db.insertRawEvent({
        id,
        platform: "slack",
        accountKey: "default",
        entityKind: "message",
        eventKind: "created",
        observedAt: 1_710_000_000_000 + i,
        dedupeKey: id,
        payload: {
          sourceMessageKey: id,
          sourceConversationKey: `thread-${i % conversationCount}`,
          senderSourceKey: "sender",
          sentAt: 1_710_000_000_000 + i,
          content: "Benchmark message",
          service: "slack",
          isFromMe: false,
        },
      });
    }
    const start = performance.now();
    const result = projectPendingRawEvents(db, { limit: eventCount });
    const elapsedMs = performance.now() - start;
    if (result.appliedRawEvents !== eventCount)
      throw new Error("Projection did not apply all events");
    // First pass hydrates caches and warms SQL; retain subsequent equally-sized batches.
    if (iteration > 0) samples.push(elapsedMs);
  }
  console.log(
    JSON.stringify(
      {
        conversationCount,
        eventCount,
        samplesMs: samples,
        medianMs: [...samples].sort((a, b) => a - b)[1],
        maxRssKiB: process.resourceUsage().maxRSS,
        projectedMessages: db.orm().get(sql`SELECT COUNT(*) AS count FROM messages`),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

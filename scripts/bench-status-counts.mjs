#!/usr/bin/env node
// Run identical synthetic workloads against a built checkout. No live account access.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const rows = Number(process.env.CUED_BENCH_ROWS ?? 50000);
const home = mkdtempSync(join(tmpdir(), "cued-status-perf-"));
process.env.CUED_HOME = home;
process.env.CUED_DB_KEY = "isolated-status-benchmark-key";
const { CuedDatabase } = await import(pathToFileURL(join(root, "dist/db/database.js")));
const { openSqliteDatabase } = await import(pathToFileURL(join(root, "dist/db/sqlite.js")));
const results = [];
try {
  for (let run = 0; run < 3; run++) {
    const path = join(home, `run-${run}.db`);
    const db = new CuedDatabase(path);
    db.migrate();
    const sql = openSqliteDatabase(path);
    sql.pragma("foreign_keys=ON");
    sql.exec(`INSERT INTO conversations(id, platform, account_key, source_conversation_key, type, created_at, updated_at)
      VALUES('c', 'slack', 'team', 'c', 'channel', 1, 1)`);
    const raw =
      sql.prepare(`INSERT INTO raw_events(id, platform, account_key, entity_kind, event_kind, observed_at, dedupe_key, payload_json)
      VALUES(?, 'slack', 'team', 'message', 'created', 1, ?, '{}')`);
    const message =
      sql.prepare(`INSERT INTO messages(id, platform, account_key, platform_message_id, conversation_id, sent_at, content, created_at, updated_at)
      VALUES(?, 'slack', 'team', ?, 'c', 1, 'Synthetic benchmark message', 1, 1)`);
    let start = performance.now();
    sql.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const id = String(i);
        raw.run(id, id);
        message.run(id, id);
      }
    })();
    const insertMs = performance.now() - start;
    sql.exec(
      "INSERT INTO message_fts_index_queue(message_id, reason, status, queued_at, updated_at) SELECT id, 'benchmark', 'queued', 1, 1 FROM messages",
    );
    const status = () => ({
      overview: db.getMenuBarOverview(),
      integrations: db.listProjectionCountsByIntegration(),
      calls: db.countObservedPhoneCalls(),
      queue: db.getMessageFtsIndexBacklog(),
    });
    for (let i = 0; i < 5; i++) status();
    const cpu = process.cpuUsage();
    start = performance.now();
    let last;
    for (let i = 0; i < 100; i++) last = status();
    const statusMs = (performance.now() - start) / 100;
    const used = process.cpuUsage(cpu);
    const heartbeatStart = performance.now();
    for (let i = 0; i < 100; i++) {
      db.upsertDaemonState({ pid: process.pid, startedAt: 1, updatedAt: i + 1, status: "running" });
      status();
    }
    const heartbeatStatusMs = (performance.now() - heartbeatStart) / 100;

    if (
      last.overview.messages !== rows ||
      last.overview.rawEvents !== rows ||
      last.queue.pending !== rows
    )
      throw Error("Incorrect benchmark output");
    results.push({
      insertMs,
      statusMs,
      heartbeatStatusMs,
      statusCpuMs: (used.user + used.system) / 1000 / 100,
      rssMiB: process.memoryUsage().rss / 1048576,
      messages: last.overview.messages,
    });
    sql.close();
    db.close();
  }
  const median = (key) => results.map((r) => r[key]).sort((a, b) => a - b)[1];
  console.log(
    JSON.stringify(
      {
        root,
        rows,
        runs: results,
        median: {
          insertMs: median("insertMs"),
          statusMs: median("statusMs"),
          heartbeatStatusMs: median("heartbeatStatusMs"),
          statusCpuMs: median("statusCpuMs"),
          rssMiB: median("rssMiB"),
        },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

import type { AdapterWorkerOutput } from "../core/sync.js";
import { buildIMessageSyncBundle, DEFAULT_IMESSAGE_BATCH_LIMIT } from "./sync.js";

async function main(): Promise<void> {
  try {
    const sourceCursor = process.env.CUED_IMESSAGE_SOURCE_CURSOR
      ? JSON.parse(process.env.CUED_IMESSAGE_SOURCE_CURSOR)
      : undefined;
    const bundle = buildIMessageSyncBundle({
      path: process.env.CUED_IMESSAGE_DB_PATH || undefined,
      lastRowId: Number(process.env.CUED_IMESSAGE_LAST_ROWID || "0"),
      sourceCursor,
      limit: Number(process.env.CUED_IMESSAGE_BATCH_LIMIT || String(DEFAULT_IMESSAGE_BATCH_LIMIT)),
      callHistoryPath: process.env.CUED_CALL_HISTORY_DB_PATH || undefined,
    });
    const output: AdapterWorkerOutput = { ok: true, bundle };
    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    const output: AdapterWorkerOutput = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(JSON.stringify(output));
    process.exitCode = 1;
  }
}

void main();

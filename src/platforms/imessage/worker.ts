import type { AdapterWorkerOutput } from "../core/sync.js";
import { buildIMessageSyncBundle } from "./sync.js";

async function main(): Promise<void> {
  try {
    const bundle = buildIMessageSyncBundle({
      path: process.env.CUED_IMESSAGE_DB_PATH || undefined,
      lastRowId: Number(process.env.CUED_IMESSAGE_LAST_ROWID || "0"),
      limit: Number(process.env.CUED_IMESSAGE_BATCH_LIMIT || "2000"),
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

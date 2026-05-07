import { readAdapterInvocationEnv } from "../core/invocation.js";
import type { AdapterWorkerOutput } from "../core/sync.js";
import { buildIMessageSyncBundle, DEFAULT_IMESSAGE_BATCH_LIMIT } from "./sync.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv();
    const bundle = buildIMessageSyncBundle({
      path: process.env.CUED_IMESSAGE_DB_PATH || undefined,
      sourceCursor: invocation.sourceCursor,
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

import { readAdapterInvocationEnv } from "../core/invocation.js";
import { runAdapterWorker } from "../core/utils.js";
import { buildIMessageSyncBundle, DEFAULT_IMESSAGE_BATCH_LIMIT } from "./sync.js";

void runAdapterWorker(async () => {
  const invocation = readAdapterInvocationEnv("imessage");
  return buildIMessageSyncBundle({
    path: process.env.CUED_IMESSAGE_DB_PATH || undefined,
    lastRowId: Number(process.env.CUED_IMESSAGE_LAST_ROWID || "0"),
    sourceCursor: invocation.sourceCursor,
    limit: Number(process.env.CUED_IMESSAGE_BATCH_LIMIT || String(DEFAULT_IMESSAGE_BATCH_LIMIT)),
    callHistoryPath: process.env.CUED_CALL_HISTORY_DB_PATH || undefined,
  });
});

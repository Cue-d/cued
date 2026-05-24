import { runAdapterWorker } from "../../core/adapter-worker.js";
import { buildSignalSyncBundle } from "./bundle.js";

void runAdapterWorker(async () => {
  const lastSyncAt = process.env.CUED_SIGNAL_LAST_SYNC_AT
    ? Number(process.env.CUED_SIGNAL_LAST_SYNC_AT)
    : undefined;
  return buildSignalSyncBundle({
    accountKey: process.env.CUED_ACCOUNT_KEY,
    account: process.env.CUED_SIGNAL_ACCOUNT,
    lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : undefined,
  });
});

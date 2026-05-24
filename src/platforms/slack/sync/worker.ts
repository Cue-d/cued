import { runAdapterWorker } from "../../core/adapter-worker.js";
import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { isSlackAuthInvalidationError } from "../helper/client.js";
import { buildSlackSyncBundle } from "./bundle.js";

void runAdapterWorker(async () => {
  const lastSyncAt = process.env.CUED_SLACK_LAST_SYNC_AT
    ? Number(process.env.CUED_SLACK_LAST_SYNC_AT)
    : undefined;
  const invocation = readAdapterInvocationEnv("slack");
  const apiPageBudget = process.env.CUED_SLACK_API_PAGE_BUDGET
    ? Number(process.env.CUED_SLACK_API_PAGE_BUDGET)
    : undefined;
  return buildSlackSyncBundle({
    accountKey: process.env.CUED_ACCOUNT_KEY,
    lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : undefined,
    sourceCursor: invocation.sourceCursor,
    syncProofs: invocation.syncProofs,
    apiPageBudget: Number.isFinite(apiPageBudget) ? apiPageBudget : undefined,
  });
}, isSlackAuthInvalidationError);

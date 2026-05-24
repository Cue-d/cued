import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { runAdapterWorker } from "../../core/utils.js";
import { LinkedInAuthError } from "../api/request.js";

import { buildLinkedInSyncBundle } from "./bundle.js";

void runAdapterWorker(async () => {
  const lastSyncAt = process.env.CUED_LINKEDIN_LAST_SYNC_AT
    ? Number(process.env.CUED_LINKEDIN_LAST_SYNC_AT)
    : undefined;
  const invocation = readAdapterInvocationEnv("linkedin");
  return buildLinkedInSyncBundle({
    accountKey: process.env.CUED_ACCOUNT_KEY,
    lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : undefined,
    syncToken: process.env.CUED_LINKEDIN_SYNC_TOKEN ?? null,
    sourceCursor: invocation.sourceCursor,
    syncProofs: invocation.syncProofs,
  });
}, (error) => error instanceof LinkedInAuthError);

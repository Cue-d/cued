import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { runAdapterWorker } from "../../core/utils.js";
import { isGmailAuthInvalidationError } from "../api/client.js";

import { buildGmailSyncBundle } from "./bundle.js";

void runAdapterWorker(async () => {
  const invocation = readAdapterInvocationEnv("gmail");
  const pageBudget = process.env.CUED_GMAIL_PAGE_BUDGET
    ? Number(process.env.CUED_GMAIL_PAGE_BUDGET)
    : undefined;
  const pageSize = process.env.CUED_GMAIL_PAGE_SIZE
    ? Number(process.env.CUED_GMAIL_PAGE_SIZE)
    : undefined;
  const fetchConcurrency = process.env.CUED_GMAIL_FETCH_CONCURRENCY
    ? Number(process.env.CUED_GMAIL_FETCH_CONCURRENCY)
    : undefined;
  return buildGmailSyncBundle({
    accountKey: process.env.CUED_ACCOUNT_KEY,
    sourceCursor: invocation.sourceCursor,
    pageBudget: Number.isFinite(pageBudget) ? pageBudget : undefined,
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    fetchConcurrency: Number.isFinite(fetchConcurrency) ? fetchConcurrency : undefined,
  });
}, isGmailAuthInvalidationError);

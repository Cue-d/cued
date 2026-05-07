import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildGmailSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv();
    const pageBudget = process.env.CUED_GMAIL_PAGE_BUDGET
      ? Number(process.env.CUED_GMAIL_PAGE_BUDGET)
      : undefined;
    const pageSize = process.env.CUED_GMAIL_PAGE_SIZE
      ? Number(process.env.CUED_GMAIL_PAGE_SIZE)
      : undefined;
    const fetchConcurrency = process.env.CUED_GMAIL_FETCH_CONCURRENCY
      ? Number(process.env.CUED_GMAIL_FETCH_CONCURRENCY)
      : undefined;
    const bundle = await buildGmailSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
      sourceCursor: invocation.sourceCursor,
      pageBudget: Number.isFinite(pageBudget) ? pageBudget : undefined,
      pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
      fetchConcurrency: Number.isFinite(fetchConcurrency) ? fetchConcurrency : undefined,
    });
    process.stdout.write(JSON.stringify({ ok: true, bundle }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();

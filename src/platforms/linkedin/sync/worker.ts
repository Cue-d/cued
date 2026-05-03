import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildLinkedInSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const lastSyncAt = process.env.CUED_LINKEDIN_LAST_SYNC_AT
      ? Number(process.env.CUED_LINKEDIN_LAST_SYNC_AT)
      : undefined;
    const invocation = readAdapterInvocationEnv("linkedin");
    const bundle = await buildLinkedInSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
      lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : undefined,
      syncToken: process.env.CUED_LINKEDIN_SYNC_TOKEN ?? null,
      sourceCursor: invocation.sourceCursor,
      syncProofs: invocation.syncProofs,
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

import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildLinkedInSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv();
    const bundle = await buildLinkedInSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
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

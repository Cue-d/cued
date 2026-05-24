import { readAdapterInvocation } from "../../core/invocation.js";
import { buildLinkedInSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = await readAdapterInvocation();
    const bundle = await buildLinkedInSyncBundle({
      accountKey: invocation.accountKey,
      lastSyncAt: invocation.lastSyncAt,
      syncToken: invocation.syncToken ?? null,
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

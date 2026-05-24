import { readAdapterInvocation } from "../../core/invocation.js";
import { buildGmailSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = await readAdapterInvocation();
    const bundle = await buildGmailSyncBundle({
      accountKey: invocation.accountKey,
      sourceCursor: invocation.sourceCursor,
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

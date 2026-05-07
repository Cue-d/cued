import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildSignalSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv();
    const bundle = await buildSignalSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
      account: process.env.CUED_SIGNAL_ACCOUNT,
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

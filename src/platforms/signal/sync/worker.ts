import { readAdapterInvocation } from "../../core/invocation.js";
import { buildSignalSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = await readAdapterInvocation();
    const bundle = await buildSignalSyncBundle({
      accountKey: invocation.accountKey,
      account: invocation.signalAccount,
      lastSyncAt: invocation.lastSyncAt,
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

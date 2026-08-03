import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildXSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv("x");
    const bundle = await buildXSyncBundle(
      { accountKey: process.env.CUED_ACCOUNT_KEY },
      { sourceCursor: invocation.sourceCursor },
    );
    process.stdout.write(JSON.stringify({ ok: true, bundle }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

void main();

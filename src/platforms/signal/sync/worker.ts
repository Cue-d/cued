import { buildSignalSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const lastSyncAt = process.env.CUED_SIGNAL_LAST_SYNC_AT
      ? Number(process.env.CUED_SIGNAL_LAST_SYNC_AT)
      : undefined;
    const bundle = await buildSignalSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
      account: process.env.CUED_SIGNAL_ACCOUNT,
      lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : undefined,
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

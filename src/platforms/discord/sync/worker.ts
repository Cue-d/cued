import { buildDiscordSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const bundle = await buildDiscordSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
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

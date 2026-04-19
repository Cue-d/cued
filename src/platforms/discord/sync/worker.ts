import { buildDiscordSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const sourceCursor = process.env.CUED_DISCORD_SOURCE_CURSOR
      ? JSON.parse(process.env.CUED_DISCORD_SOURCE_CURSOR)
      : undefined;
    const bundle = await buildDiscordSyncBundle(
      {
        accountKey: process.env.CUED_ACCOUNT_KEY,
      },
      {
        sourceCursor,
      },
    );
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

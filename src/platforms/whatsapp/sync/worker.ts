import { readAdapterInvocationEnv } from "../../core/invocation.js";
import type { AdapterWorkerOutput } from "../../core/sync.js";
import { buildWhatsAppDesktopSyncBundle } from "../desktop.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv("whatsapp");
    if (
      process.env.CUED_WHATSAPP_SYNC_SOURCE === "desktop_db" ||
      process.env.CUED_WHATSAPP_DESKTOP_SOURCE_PATH
    ) {
      const bundle = buildWhatsAppDesktopSyncBundle({
        sourcePath: process.env.CUED_WHATSAPP_DESKTOP_SOURCE_PATH || undefined,
        accountKey: process.env.CUED_ACCOUNT_KEY || "default",
      });
      if (typeof invocation.sourceCursor === "object" && invocation.sourceCursor) {
        bundle.sourceCursor = {
          ...(invocation.sourceCursor as Record<string, unknown>),
          ...(bundle.sourceCursor as Record<string, unknown>),
        };
      }
      const output: AdapterWorkerOutput = { ok: true, bundle };
      process.stdout.write(JSON.stringify(output));
      return;
    }

    const output: AdapterWorkerOutput = {
      ok: true,
      bundle: {
        sourceAccounts: [],
        rawEvents: [],
        sourceCursor: {
          ...(typeof invocation.sourceCursor === "object" && invocation.sourceCursor
            ? invocation.sourceCursor
            : {}),
          note: "whatsapp_sync_via_realtime_helper",
        },
        syncMode: "incremental",
        hasMore: false,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    const output: AdapterWorkerOutput = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(JSON.stringify(output));
    process.exitCode = 1;
  }
}

void main();

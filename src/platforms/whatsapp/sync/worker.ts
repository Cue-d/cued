import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { runAdapterWorker } from "../../core/utils.js";
import { buildWhatsAppDesktopSyncBundle } from "../desktop.js";

void runAdapterWorker(async () => {
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
    return bundle;
  }

  return {
    sourceAccounts: [],
    rawEvents: [],
    sourceCursor: {
      ...(typeof invocation.sourceCursor === "object" && invocation.sourceCursor
        ? invocation.sourceCursor
        : {}),
      note: "whatsapp_sync_via_realtime_helper",
    },
    syncMode: "incremental" as const,
    hasMore: false,
  };
});

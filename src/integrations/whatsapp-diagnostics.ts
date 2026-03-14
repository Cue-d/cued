import type { CuedDatabase } from "../db/database.js";
import type { WhatsAppRealtimeStatus } from "./whatsapp-realtime.js";

export function buildWhatsAppDiagnostics(
  db: CuedDatabase,
  realtimeStatuses: WhatsAppRealtimeStatus[] = [],
): Array<{
  accountKey: string;
  authSessionState: string | null;
  realtimeState: string | null;
  accountJid: string | null;
  lastHelperConnectionError: string | null;
  lastHistorySyncAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSuccessfulSyncMode: string | null;
  latestSyncError: string | null;
}> {
  const realtimeByAccount = new Map(
    realtimeStatuses.map((status) => [status.accountKey, status] as const),
  );
  const accountKeys = new Set<string>(["default"]);

  for (const status of realtimeStatuses) {
    accountKeys.add(status.accountKey);
  }
  for (const integration of db.listIntegrationStates()) {
    if (integration.platform === "whatsapp") {
      accountKeys.add(integration.account_key);
    }
  }
  for (const checkpoint of db.listCheckpointSummary()) {
    if (checkpoint.platform === "whatsapp") {
      accountKeys.add(checkpoint.account_key);
    }
  }

  return [...accountKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((accountKey) => {
      const realtime = realtimeByAccount.get(accountKey) ?? null;
      const latestAuthSession = db.getLatestAuthSession("whatsapp", accountKey);
      const checkpoint = db.getCheckpoint("whatsapp", accountKey);
      const latestSyncError = db.getLatestSyncRunError("whatsapp", accountKey);

      return {
        accountKey,
        authSessionState: latestAuthSession?.state ?? null,
        realtimeState: realtime?.state ?? null,
        accountJid: realtime?.accountJid ?? null,
        lastHelperConnectionError: realtime?.lastSessionError ?? null,
        lastHistorySyncAt: realtime?.lastHistorySyncAt ?? null,
        lastSuccessfulSyncAt: checkpoint?.last_success_at ?? null,
        lastSuccessfulSyncMode: checkpoint?.sync_mode ?? null,
        latestSyncError: latestSyncError?.error_message ?? checkpoint?.last_error_summary ?? null,
      };
    });
}

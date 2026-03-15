import type { CuedDatabase } from "../../db/database.js";
import type { WhatsAppRealtimeStatus } from "./realtime/session.js";

interface WhatsAppMetadataDiagnostics {
  accountJid: string | null;
  lastHistorySyncAt: number | null;
  lastHistorySyncType: string | null;
  lastHistoryChunkOrder: number | null;
  lastHistoryProgress: number | null;
  queuedHistorySyncCount: number | null;
  lastHistorySyncError: string | null;
  lastHistoryNotificationAt: number | null;
}

function parseWhatsAppMetadata(metadataJson: string | null): WhatsAppMetadataDiagnostics {
  const metadata = metadataJson ? (JSON.parse(metadataJson) as Record<string, unknown>) : null;
  return {
    accountJid:
      typeof metadata?.whatsappAccountJid === "string" ? metadata.whatsappAccountJid : null,
    lastHistorySyncAt:
      typeof metadata?.whatsappLastHistorySyncAt === "number"
        ? metadata.whatsappLastHistorySyncAt
        : null,
    lastHistorySyncType:
      typeof metadata?.whatsappLastHistorySyncType === "string"
        ? metadata.whatsappLastHistorySyncType
        : null,
    lastHistoryChunkOrder:
      typeof metadata?.whatsappLastHistoryChunkOrder === "number"
        ? metadata.whatsappLastHistoryChunkOrder
        : null,
    lastHistoryProgress:
      typeof metadata?.whatsappLastHistoryProgress === "number"
        ? metadata.whatsappLastHistoryProgress
        : null,
    queuedHistorySyncCount:
      typeof metadata?.whatsappQueuedHistorySyncCount === "number"
        ? metadata.whatsappQueuedHistorySyncCount
        : null,
    lastHistorySyncError:
      typeof metadata?.whatsappLastHistorySyncError === "string"
        ? metadata.whatsappLastHistorySyncError
        : null,
    lastHistoryNotificationAt:
      typeof metadata?.whatsappLastHistoryNotificationAt === "number"
        ? metadata.whatsappLastHistoryNotificationAt
        : null,
  };
}

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
  lastHistorySyncType: string | null;
  lastHistoryChunkOrder: number | null;
  lastHistoryProgress: number | null;
  queuedHistorySyncCount: number | null;
  lastHistorySyncError: string | null;
  lastHistoryNotificationAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSuccessfulSyncMode: string | null;
  latestSyncError: string | null;
}> {
  const realtimeByAccount = new Map(
    realtimeStatuses.map((status) => [status.accountKey, status] as const),
  );
  const metadataByAccount = new Map(
    db
      .listIntegrationStates()
      .filter((integration) => integration.platform === "whatsapp")
      .map(
        (integration) =>
          [integration.account_key, parseWhatsAppMetadata(integration.metadata_json)] as const,
      ),
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
      const metadata = metadataByAccount.get(accountKey) ?? null;
      const latestAuthSession = db.getLatestAuthSession("whatsapp", accountKey);
      const checkpoint = db.getCheckpoint("whatsapp", accountKey);
      const latestSyncError = db.getLatestSyncRunError("whatsapp", accountKey);

      return {
        accountKey,
        authSessionState: latestAuthSession?.state ?? null,
        realtimeState: realtime?.state ?? null,
        accountJid: realtime?.accountJid ?? metadata?.accountJid ?? null,
        lastHelperConnectionError: realtime?.lastSessionError ?? null,
        lastHistorySyncAt: realtime?.lastHistorySyncAt ?? metadata?.lastHistorySyncAt ?? null,
        lastHistorySyncType: metadata?.lastHistorySyncType ?? null,
        lastHistoryChunkOrder: metadata?.lastHistoryChunkOrder ?? null,
        lastHistoryProgress: metadata?.lastHistoryProgress ?? null,
        queuedHistorySyncCount: metadata?.queuedHistorySyncCount ?? null,
        lastHistorySyncError: metadata?.lastHistorySyncError ?? null,
        lastHistoryNotificationAt: metadata?.lastHistoryNotificationAt ?? null,
        lastSuccessfulSyncAt: checkpoint?.last_success_at ?? null,
        lastSuccessfulSyncMode: checkpoint?.sync_mode ?? null,
        latestSyncError: latestSyncError?.error_message ?? checkpoint?.last_error_summary ?? null,
      };
    });
}

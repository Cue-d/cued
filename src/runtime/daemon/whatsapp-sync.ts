import type {
  WhatsAppHelperEventEnvelope,
  WhatsAppHistoryBackfillAnchor,
  WhatsAppHistoryBackfillResult,
  WhatsAppSnapshot,
} from "../../platforms/whatsapp/types.js";
import { now } from "./settings.js";

export async function requestWhatsAppHistoryBackfillOnce(input: {
  anchors: WhatsAppHistoryBackfillAnchor[];
  request: (input: {
    anchors: WhatsAppHistoryBackfillAnchor[];
    limit: number;
    waitMs: number;
  }) => Promise<WhatsAppHistoryBackfillResult>;
  nowMs?: () => number;
}): Promise<{
  historyBackfillRequestedAt: number | null;
  diagnostics: Record<string, unknown>;
}> {
  const requestedAt = input.nowMs?.() ?? now();
  try {
    const backfill = await input.request({
      anchors: input.anchors,
      limit: 50,
      waitMs: 10_000,
    });
    return {
      historyBackfillRequestedAt: requestedAt,
      diagnostics: {
        requested: backfill.requested,
        failed: backfill.failed,
        queuedHistorySyncCount: backfill.queuedHistorySyncCount,
        lastHistorySyncAt: backfill.lastHistorySyncAt ?? null,
        lastHistoryNotificationAt: backfill.lastHistoryNotificationAt ?? null,
        errors: backfill.errors?.slice(0, 5) ?? [],
      },
    };
  } catch (error) {
    return {
      historyBackfillRequestedAt: null,
      diagnostics: {
        requested: 0,
        failed: input.anchors.length,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function buildWhatsAppRealtimeSnapshotFromEvent(
  event: WhatsAppHelperEventEnvelope,
): WhatsAppSnapshot | null {
  switch (event.event) {
    case "contact_upsert":
      return {
        identityAliases: event.identityAliases,
        contacts: [event.data as WhatsAppHelperEventEnvelope<"contact_upsert">["data"]],
      };
    case "chat_upsert":
      return {
        identityAliases: event.identityAliases,
        chats: [event.data as WhatsAppHelperEventEnvelope<"chat_upsert">["data"]],
      };
    case "message_upsert":
      return {
        identityAliases: event.identityAliases,
        messages: [event.data as WhatsAppHelperEventEnvelope<"message_upsert">["data"]],
      };
    case "call_upsert":
      return {
        identityAliases: event.identityAliases,
        calls: [event.data as WhatsAppHelperEventEnvelope<"call_upsert">["data"]],
      };
    case "history_sync":
      return {
        ...(event.data as WhatsAppHelperEventEnvelope<"history_sync">["data"]),
        identityAliases: event.identityAliases,
      };
    default:
      return null;
  }
}

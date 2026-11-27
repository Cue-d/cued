import { createLogger } from "../../core/logging.js";
import type { AdapterPlatform, ProviderRawEventInput } from "../../core/types/provider.js";
import { safeParseJsonRecord } from "../../db/codecs.js";
import type { CuedDatabase } from "../../db/database.js";
import type { DiscordRealtimeEventEnvelope } from "../../platforms/discord/realtime/session.js";
import {
  buildDiscordContactEvent,
  buildDiscordConversationEvent,
  buildDiscordMessageEvent,
} from "../../platforms/discord/sync/events.js";
import { buildLinkedInRawEventsFromRealtimeEnvelope } from "../../platforms/linkedin/realtime/events.js";
import { buildSignalRawEventsFromMessages } from "../../platforms/signal/sync/events.js";
import type { SlackRealtimeEventEnvelope } from "../../platforms/slack/realtime/session.js";
import {
  buildSlackContactEvents,
  buildSlackConversationEvent,
  buildSlackMessageEvents,
} from "../../platforms/slack/sync/events.js";
import {
  buildWhatsAppCallDeleteEvent,
  buildWhatsAppIdentityAliasEvents,
  buildWhatsAppRawEventsFromSnapshot,
} from "../../platforms/whatsapp/sync/events.js";
import type {
  WhatsAppHelperEventEnvelope,
  WhatsAppReceiptSnapshot,
  WhatsAppSnapshot,
} from "../../platforms/whatsapp/types.js";
import { collectInboundMessageHookPayloads } from "../message-hooks.js";
import { canonicalizeWhatsAppSourceKey } from "../projection/identity-alias.js";
import { projectRealtimeRange } from "../projection/projector.js";
import type { ProjectionMessageHookPayload } from "../projection/service.js";
import { queueNativeTriggeredSync } from "./native-watchers.js";
import { isInboundMessageEvent, withRawEventAcquisitionMode } from "./raw-events.js";
import { isSqliteBusyError, now } from "./settings.js";
import { buildWhatsAppRealtimeSnapshotFromEvent } from "./whatsapp-sync.js";

const linkedInLogger = createLogger("linkedin");
const discordLogger = createLogger("discord");
const slackLogger = createLogger("slack");
const signalLogger = createLogger("signal");
const whatsAppLogger = createLogger("whatsapp");

/** What realtime ingestion reads from the daemon that runs it. */
export type RealtimeIngestDeps = {
  db: CuedDatabase;
  schedulers: { wakeIngest: (delayMs?: number) => void };
  realtimeProjectionEnabled: boolean;
  realtimeProjectionBatchSize: number;
  deferredProjectionCoalesceMs: number;
  isProcessingProjection: () => boolean;
  scheduleSearchIndexDrain: (delayMs?: number) => void;
  queueProjectionRun: (
    trigger: string,
    range?: { startRowId: number; endRowId: number },
    options?: { delayMs?: number },
  ) => unknown;
  queueMessageReceivedHooks: (
    range: { startRowId: number; endRowId: number } | null,
    inboundMessages: ProjectionMessageHookPayload[],
  ) => void;
  releaseMessageReceivedHooksForRange: (range: {
    startRowId: number;
    endRowId: number;
  }) => Promise<void>;
};

/**
 * Records what the realtime sessions report as raw events, projects small batches inline,
 * advances each account's checkpoint and queues message hooks. When the write lock is busy it
 * falls back to queueing a sync of the account.
 */
export function createRealtimeIngest(deps: RealtimeIngestDeps) {
  const {
    db,
    schedulers,
    realtimeProjectionEnabled,
    realtimeProjectionBatchSize,
    deferredProjectionCoalesceMs,
    isProcessingProjection,
    scheduleSearchIndexDrain,
    queueProjectionRun,
    queueMessageReceivedHooks,
    releaseMessageReceivedHooksForRange,
  } = deps;

  const updateSlackCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("slack", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "slack",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestSlackRealtimeRawEvents = async (
    accountKey: string,
    rawEvents: ReturnType<typeof buildSlackMessageEvents>,
    trigger: string,
  ): Promise<void> => {
    try {
      const platform = "slack" satisfies AdapterPlatform;
      if (rawEvents.length === 0) {
        return;
      }
      if (isProcessingProjection()) {
        queueNativeTriggeredSync(
          db,
          platform,
          accountKey,
          `${trigger}:projection_busy`,
          schedulers.wakeIngest,
        );
        return;
      }

      db.upsertSourceAccounts([
        {
          platform,
          accountKey,
          displayName: "Slack",
        },
      ]);
      const insertResult = db.insertRawEvents(withRawEventAcquisitionMode(rawEvents, "realtime"));
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateSlackCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slackLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "slack",
          accountKey,
          "slack_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateDiscordCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("discord", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "discord",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestDiscordRealtimeRawEvents = async (
    accountKey: string,
    rawEvents: ProviderRawEventInput[],
    trigger: string,
    sourceAccountDisplayName = "Discord",
  ): Promise<void> => {
    try {
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "discord",
          accountKey,
          displayName: sourceAccountDisplayName,
        },
      ]);
      const insertResult = db.insertRawEvents(withRawEventAcquisitionMode(rawEvents, "realtime"));
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateDiscordCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      discordLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "discord",
          accountKey,
          "discord_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const handleSlackRealtimeEvent = async (
    accountKey: string,
    event: SlackRealtimeEventEnvelope,
  ): Promise<void> => {
    const observedAt = now();
    switch (event.event) {
      case "contact_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          buildSlackContactEvents(event.data.teamId, accountKey, observedAt, [event.data.user]),
          `slack_realtime:${accountKey}`,
        );
        return;
      case "conversation_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          [
            buildSlackConversationEvent({
              teamId: event.data.teamId,
              accountKey,
              conversation: event.data.conversation,
              observedAt,
              memberIds: event.data.memberIds,
              selfUserId: event.data.selfUserId,
              displayName: event.data.displayName,
            }),
          ],
          `slack_realtime:${accountKey}`,
        );
        if (event.data.isNew) {
          queueNativeTriggeredSync(
            db,
            "slack",
            accountKey,
            "slack_realtime_new_conversation",
            schedulers.wakeIngest,
          );
        }
        return;
      case "message_upsert":
        await ingestSlackRealtimeRawEvents(
          accountKey,
          buildSlackMessageEvents({
            teamId: event.data.teamId,
            accountKey,
            conversationId: event.data.conversationId,
            selfUserId: event.data.selfUserId,
            observedAt,
            messages: [event.data.message],
          }),
          `slack_realtime:${accountKey}`,
        );
        return;
      default:
        return;
    }
  };

  const handleDiscordRealtimeEvent = async (
    accountKey: string,
    event: DiscordRealtimeEventEnvelope,
  ): Promise<void> => {
    const observedAt = now();
    switch (event.event) {
      case "contact_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordContactEvent({
              accountKey,
              observedAt,
              user: event.data.user,
              displayName: event.data.displayName,
            }),
          ],
          `discord_realtime:${accountKey}`,
        );
        return;
      case "conversation_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordConversationEvent({
              accountKey,
              observedAt,
              channel: event.data.channel,
              currentUser: event.data.currentUser,
            }),
          ],
          `discord_realtime:${accountKey}`,
          event.data.currentUser.global_name?.trim() || event.data.currentUser.username,
        );
        if (event.data.isNew) {
          queueNativeTriggeredSync(
            db,
            "discord",
            accountKey,
            "discord_realtime_new_conversation",
            schedulers.wakeIngest,
          );
        }
        return;
      case "message_upsert":
        await ingestDiscordRealtimeRawEvents(
          accountKey,
          [
            buildDiscordMessageEvent({
              accountKey,
              observedAt,
              channel: event.data.channel,
              message: event.data.message,
              currentUserId: event.data.currentUserId,
            }),
          ],
          `discord_realtime:${accountKey}`,
        );
        return;
      default:
        return;
    }
  };

  const updateLinkedInCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("linkedin", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "linkedin",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestLinkedInRealtimeEnvelope = async (
    accountKey: string,
    envelope: Parameters<typeof buildLinkedInRawEventsFromRealtimeEnvelope>[0]["envelope"],
    userEntityUrn: string,
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildLinkedInRawEventsFromRealtimeEnvelope({
          accountKey,
          userEntityUrn,
          envelope,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "linkedin",
          accountKey,
          displayName: "LinkedIn",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(`linkedin_realtime:${accountKey}`, undefined, {
          delayMs: deferredProjectionCoalesceMs,
        });
      }
      if (insertResult.insertedCount > 0) {
        updateLinkedInCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        `linkedin_realtime:${accountKey}`,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      linkedInLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "linkedin",
          accountKey,
          "linkedin_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateSignalCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("signal", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "signal",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestSignalRealtimeMessages = async (
    accountKey: string,
    messages: Parameters<typeof buildSignalRawEventsFromMessages>[0]["messages"],
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildSignalRawEventsFromMessages({
          accountKey,
          messages,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "signal",
          accountKey,
          displayName: "Signal",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(`signal_realtime:${accountKey}`, undefined, {
          delayMs: deferredProjectionCoalesceMs,
        });
      }
      if (insertResult.insertedCount > 0) {
        updateSignalCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        `signal_realtime:${accountKey}`,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signalLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "signal",
          accountKey,
          "signal_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const updateWhatsAppCheckpointFromRealtime = (accountKey: string) => {
    const checkpoint = db.getCheckpoint("whatsapp", accountKey);
    const projection = db.getProjectionBacklog();
    const sourceCursor = safeParseJsonRecord(
      checkpoint?.source_cursor_json ?? null,
      "sync_checkpoints.source_cursor_json",
    );
    db.upsertCheckpoint({
      platform: "whatsapp",
      accountKey,
      syncMode: checkpoint?.sync_mode ?? "incremental",
      sourceCursor,
      rawIngestWatermark: projection.max_raw_event_rowid,
      lastSuccessAt: now(),
      lastErrorSummary: null,
    });
  };

  const ingestWhatsAppRealtimeSnapshot = async (
    accountKey: string,
    snapshot: WhatsAppSnapshot,
    trigger: string,
  ): Promise<void> => {
    try {
      const rawEvents = withRawEventAcquisitionMode(
        buildWhatsAppRawEventsFromSnapshot({
          accountKey,
          snapshot,
        }),
        "realtime",
      );
      if (rawEvents.length === 0) {
        return;
      }

      db.upsertSourceAccounts([
        {
          platform: "whatsapp",
          accountKey,
          displayName: "WhatsApp",
        },
      ]);
      const insertResult = db.insertRawEvents(rawEvents);
      if (
        realtimeProjectionEnabled &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        projectRealtimeRange(db, {
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
          batchSize: realtimeProjectionBatchSize,
          includeOverview: false,
        });
        scheduleSearchIndexDrain();
      }
      const projection = db.getProjectionBacklog();
      if (projection.pending_raw_events > 0) {
        queueProjectionRun(trigger, undefined, { delayMs: deferredProjectionCoalesceMs });
      }
      if (insertResult.insertedCount > 0) {
        updateWhatsAppCheckpointFromRealtime(accountKey);
      }

      const inboundMessages = collectInboundMessageHookPayloads(
        trigger,
        insertResult.insertedRows,
        isInboundMessageEvent,
      );
      queueMessageReceivedHooks(
        insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null
          ? {
              startRowId: insertResult.firstInsertedRowId,
              endRowId: insertResult.lastInsertedRowId,
            }
          : null,
        inboundMessages,
      );
      if (
        projection.pending_raw_events === 0 &&
        insertResult.firstInsertedRowId != null &&
        insertResult.lastInsertedRowId != null
      ) {
        await releaseMessageReceivedHooksForRange({
          startRowId: insertResult.firstInsertedRowId,
          endRowId: insertResult.lastInsertedRowId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      whatsAppLogger.warn("realtime ingest failed", { accountKey, error: message });
      if (isSqliteBusyError(error)) {
        queueNativeTriggeredSync(
          db,
          "whatsapp",
          accountKey,
          "whatsapp_realtime_busy_fallback",
          schedulers.wakeIngest,
        );
      }
    }
  };

  const applyReceiptToRealtimeSnapshot = async (
    accountKey: string,
    receipt: WhatsAppReceiptSnapshot,
    identityAliases: NonNullable<WhatsAppHelperEventEnvelope["identityAliases"]> = [],
  ): Promise<void> => {
    const rawKey = `${receipt.chatJID.toLowerCase()}:${receipt.messageID}`;
    const alias = identityAliases.find((entry) => entry.lid === receipt.chatJID.toLowerCase());
    // Projection may be deferred; try both the persisted mapping and the explicit
    // mapping in this envelope before the original provider key.
    const candidates = new Set([
      canonicalizeWhatsAppSourceKey(db.orm(), accountKey, rawKey),
      ...(alias ? [`${alias.pn}:${receipt.messageID}`] : []),
      rawKey,
    ]);
    const message = [...candidates]
      .map((key) => db.findMessageByPlatformKey("whatsapp", accountKey, key))
      .find(Boolean);
    if (!message) {
      return;
    }

    await ingestWhatsAppRealtimeSnapshot(
      accountKey,
      {
        messages: [
          {
            messageID: receipt.messageID,
            chatJID: receipt.chatJID,
            senderJID: message.sender_source_key?.replace(/^whatsapp:/, "") ?? receipt.chatJID,
            fromMe: receipt.fromMe,
            timestamp: message.sent_at ?? now(),
            text: message.content ?? "",
            status: receipt.status ?? message.status ?? null,
            deliveredAt: receipt.deliveredAt ?? message.delivered_at ?? null,
            readAt: receipt.readAt ?? message.read_at ?? null,
          },
        ],
      },
      `whatsapp_receipt:${accountKey}`,
    );
  };

  const handleWhatsAppRealtimeEvent = async (
    accountKey: string,
    event: WhatsAppHelperEventEnvelope,
  ): Promise<void> => {
    const snapshot = buildWhatsAppRealtimeSnapshotFromEvent(event);
    if (snapshot) {
      await ingestWhatsAppRealtimeSnapshot(
        accountKey,
        snapshot,
        event.event === "history_sync"
          ? `whatsapp_history_sync:${accountKey}`
          : `whatsapp_realtime:${accountKey}`,
      );
      return;
    }
    switch (event.event) {
      case "call_delete": {
        const callDelete = event.data as WhatsAppHelperEventEnvelope<"call_delete">["data"];
        const rawEvents = withRawEventAcquisitionMode(
          [
            ...buildWhatsAppIdentityAliasEvents(event.identityAliases ?? [], accountKey, now()),
            buildWhatsAppCallDeleteEvent(callDelete, accountKey, now()),
          ],
          "realtime",
        );
        db.upsertSourceAccounts([
          {
            platform: "whatsapp",
            accountKey,
            displayName: "WhatsApp",
          },
        ]);
        const insertResult = db.insertRawEvents(rawEvents);
        if (
          realtimeProjectionEnabled &&
          insertResult.firstInsertedRowId != null &&
          insertResult.lastInsertedRowId != null
        ) {
          projectRealtimeRange(db, {
            startRowId: insertResult.firstInsertedRowId,
            endRowId: insertResult.lastInsertedRowId,
            batchSize: realtimeProjectionBatchSize,
            includeOverview: false,
          });
          scheduleSearchIndexDrain();
        }
        const projection = db.getProjectionBacklog();
        if (projection.pending_raw_events > 0) {
          queueProjectionRun(`whatsapp_realtime:${accountKey}`, undefined, {
            delayMs: deferredProjectionCoalesceMs,
          });
        }
        if (insertResult.insertedCount > 0) {
          updateWhatsAppCheckpointFromRealtime(accountKey);
        }
        return;
      }
      case "receipt_update":
        if (event.identityAliases?.length) {
          await ingestWhatsAppRealtimeSnapshot(
            accountKey,
            { identityAliases: event.identityAliases },
            `whatsapp_identity:${accountKey}`,
          );
        }
        await applyReceiptToRealtimeSnapshot(
          accountKey,
          event.data as WhatsAppHelperEventEnvelope<"receipt_update">["data"],
          event.identityAliases,
        );
        return;
      default:
        return;
    }
  };

  return {
    handleSlackRealtimeEvent,
    handleDiscordRealtimeEvent,
    ingestLinkedInRealtimeEnvelope,
    ingestSignalRealtimeMessages,
    handleWhatsAppRealtimeEvent,
  };
}

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type {
  CallPayload,
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ReactionPayload,
  SourceAccountInput,
} from "../../core/types/provider.js";
import { resolveMacOSNativeBinary } from "../../runtime/native-binary.js";
import type { SyncBundle } from "../core/sync.js";
import {
  DEFAULT_CALL_HISTORY_DB_PATH,
  type ImsCallSyncBatch,
  loadCallHistoryBatch,
} from "./call-history.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "./reader.js";
import type { ImsSyncBatch } from "./types.js";

export const DEFAULT_IMESSAGE_BATCH_LIMIT = 2_000;

type IMessageSourceCursor = {
  rowId?: number;
  callPk?: number;
};

function dedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function guessHandleType(identifier: string): string {
  if (identifier.includes("@")) return "email";
  if (/^[+]?\d[\d\s()-]{5,}$/.test(identifier)) return "phone";
  return "imessage_handle";
}

function resolveIMessageSourceCursor(options?: {
  lastRowId?: number;
  sourceCursor?: unknown;
}): Required<IMessageSourceCursor> {
  const sourceCursor =
    options?.sourceCursor && typeof options.sourceCursor === "object"
      ? (options.sourceCursor as Record<string, unknown>)
      : null;
  return {
    rowId: typeof sourceCursor?.rowId === "number" ? sourceCursor.rowId : (options?.lastRowId ?? 0),
    callPk: typeof sourceCursor?.callPk === "number" ? sourceCursor.callPk : 0,
  };
}

function buildCallConversationLabel(call: {
  remoteDisplayName: string | null;
  remoteAddress: string | null;
  provider: string;
}): string | null {
  return call.remoteDisplayName ?? call.remoteAddress ?? `${call.provider} call`;
}

type IMessageLoader = { kind: "native"; path: string } | { kind: "ts"; path: string };

export function resolveIMessageLoader(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): IMessageLoader {
  const nativeBinary = resolveMacOSNativeBinary(env.CUED_IMESSAGE_NATIVE_BINARY, repoRoot);
  if (nativeBinary) {
    return {
      kind: "native",
      path: nativeBinary,
    };
  }

  return {
    kind: "ts",
    path: env.CUED_IMESSAGE_DB_PATH || DEFAULT_CHAT_DB_PATH,
  };
}

function loadBatchFromNativeBinary(
  binaryPath: string,
  options?: {
    path?: string;
    lastRowId?: number;
    limit?: number;
  },
): ImsSyncBatch {
  const args = [
    "imessage",
    "dump",
    "--db-path",
    options?.path ?? DEFAULT_CHAT_DB_PATH,
    "--after-rowid",
    String(options?.lastRowId ?? 0),
    "--limit",
    String(options?.limit ?? DEFAULT_IMESSAGE_BATCH_LIMIT),
  ];
  const stdout = execFileSync(binaryPath, args, {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ImsSyncBatch;
}

function loadCallBatchFromNativeBinary(
  binaryPath: string,
  options?: {
    callHistoryPath?: string;
    path?: string;
    afterPk?: number;
    limit?: number;
  },
): ImsCallSyncBatch {
  const args = [
    "callhistory",
    "dump",
    "--db-path",
    options?.callHistoryPath ?? DEFAULT_CALL_HISTORY_DB_PATH,
    "--chat-db-path",
    options?.path ?? DEFAULT_CHAT_DB_PATH,
    "--after-pk",
    String(options?.afterPk ?? 0),
    "--limit",
    String(options?.limit ?? DEFAULT_IMESSAGE_BATCH_LIMIT),
  ];
  const stdout = execFileSync(binaryPath, args, {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ImsCallSyncBatch;
}

function loadBatchFromTypeScript(options?: {
  path?: string;
  lastRowId?: number;
  limit?: number;
}): ImsSyncBatch {
  const reader = new IMessageReader(options?.path ?? DEFAULT_CHAT_DB_PATH);
  try {
    return reader.buildSyncBatch(
      options?.lastRowId ?? 0,
      options?.limit ?? DEFAULT_IMESSAGE_BATCH_LIMIT,
    );
  } finally {
    reader.close();
  }
}

export function buildIMessageSyncBundle(options?: {
  path?: string;
  lastRowId?: number;
  sourceCursor?: unknown;
  limit?: number;
  callHistoryPath?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): SyncBundle {
  const limit = options?.limit ?? DEFAULT_IMESSAGE_BATCH_LIMIT;
  const cursor = resolveIMessageSourceCursor(options);
  const env = options?.env ?? process.env;
  const loader = resolveIMessageLoader(options?.env ?? process.env, options?.repoRoot);
  const batch =
    loader.kind === "native"
      ? loadBatchFromNativeBinary(loader.path, {
          path: options?.path,
          lastRowId: cursor.rowId,
          limit,
        })
      : loadBatchFromTypeScript({
          path: options?.path,
          lastRowId: cursor.rowId,
          limit,
        });
  const effectiveCallBatch =
    loader.kind === "native"
      ? loadCallBatchFromNativeBinary(loader.path, {
          callHistoryPath:
            options?.callHistoryPath ??
            env.CUED_CALL_HISTORY_DB_PATH ??
            DEFAULT_CALL_HISTORY_DB_PATH,
          path: options?.path ?? env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH,
          afterPk: cursor.callPk,
          limit,
        })
      : loadCallHistoryBatch({
          path:
            options?.callHistoryPath ??
            env.CUED_CALL_HISTORY_DB_PATH ??
            DEFAULT_CALL_HISTORY_DB_PATH,
          chatDbPath: options?.path ?? env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH,
          afterPk: cursor.callPk,
          limit,
        });
  const hasMore = batch.fetchedCount >= limit || effectiveCallBatch.fetchedCount >= limit;
  const observedBase = Date.now();

  const sourceAccounts: SourceAccountInput[] = [
    { platform: "imessage", accountKey: "local", displayName: "Messages" },
  ];

  const rawEvents: SyncBundle["rawEvents"] = [];
  const observedContactSourceKeys = new Set<string>();
  const observedConversationSourceKeys = new Set<string>();

  for (const handle of batch.handles) {
    observedContactSourceKeys.add(`imessage:${handle.identifier}`);
    rawEvents.push({
      id: randomUUID(),
      platform: "imessage",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      externalEntityId: String(handle.id),
      observedAt: observedBase + handle.id,
      dedupeKey: dedupeKey(`imessage:contact:${handle.id}:${handle.identifier}`),
      payload: {
        sourceEntityKey: `imessage:${handle.identifier}`,
        fields: {
          display_name: handle.identifier,
        },
        handles: [
          {
            type: guessHandleType(handle.identifier),
            value: handle.identifier,
            deterministic: true,
          },
          {
            type: "imessage_handle",
            value: handle.identifier,
            deterministic: true,
          },
        ],
      } satisfies ContactObservationPayload,
      sourceVersion: "imessage-v1",
    });
  }

  for (const chat of batch.chats) {
    observedConversationSourceKeys.add(String(chat.id));
    rawEvents.push({
      id: randomUUID(),
      platform: "imessage",
      accountKey: "local",
      entityKind: "conversation",
      eventKind: "observed",
      conversationExternalId: String(chat.id),
      observedAt: observedBase + chat.id,
      dedupeKey: dedupeKey(`imessage:conversation:${chat.id}:${batch.cursor}`),
      payload: {
        sourceConversationKey: String(chat.id),
        conversationType: chat.isGroup ? "group" : "dm",
        displayName: chat.displayName ?? null,
        nativeConversationKey: chat.identifier,
        participants: chat.participants.map((participant) => ({
          sourceEntityKey: `imessage:${participant.identifier}`,
        })),
      } satisfies ConversationObservationPayload,
      sourceVersion: "imessage-v1",
    });
  }

  for (const message of batch.messages) {
    rawEvents.push({
      id: randomUUID(),
      platform: "imessage",
      accountKey: "local",
      entityKind: "message",
      eventKind: "created",
      externalEntityId: message.guid,
      conversationExternalId: String(message.chatId),
      occurredAt: message.timestamp * 1000,
      observedAt: observedBase + message.id,
      dedupeKey: dedupeKey(`imessage:message:${message.guid}`),
      payload: {
        sourceMessageKey: message.guid,
        sourceConversationKey: String(message.chatId),
        senderSourceKey: message.sender ? `imessage:${message.sender.identifier}` : null,
        sentAt: message.timestamp * 1000,
        content: message.text ?? "",
        service: message.sender?.service ?? "iMessage",
        status: message.status,
        isFromMe: message.isFromMe,
        readAt: message.readAt ? message.readAt * 1000 : null,
        isEdited: false,
        isDeleted: false,
        attachments: message.attachments.map((attachment) => ({
          id: attachment.guid,
          kind: attachment.isSticker ? "sticker" : "file",
          filename: attachment.transferName ?? attachment.filename,
          local_path: attachment.filename,
          mime_type: attachment.mimeType,
          size_bytes: attachment.totalBytes,
          access_kind: attachment.filename ? "local_path" : "none",
          availability_status: attachment.filename ? "available" : "metadata_only",
          access_ref: attachment.filename ? { path: attachment.filename } : null,
          provider_metadata: {
            uti: attachment.uti,
            isSticker: attachment.isSticker,
            hideAttachment: attachment.hideAttachment,
            ckRecordId: attachment.ckRecordId,
            sourceFilename: attachment.filename,
          },
        })),
      } satisfies MessagePayload,
      sourceVersion: "imessage-v1",
    });

    for (const reaction of message.reactions) {
      rawEvents.push({
        id: randomUUID(),
        platform: "imessage",
        accountKey: "local",
        entityKind: "reaction",
        eventKind: "added",
        externalEntityId: `${message.guid}:${reaction.reactorIdentifier}:${reaction.emoji}`,
        conversationExternalId: String(message.chatId),
        occurredAt: reaction.timestamp * 1000,
        observedAt: observedBase + message.id + reaction.timestamp,
        dedupeKey: dedupeKey(
          `imessage:reaction:${message.guid}:${reaction.reactorIdentifier}:${reaction.emoji}:${reaction.timestamp}`,
        ),
        payload: {
          sourceMessageKey: message.guid,
          sourceConversationKey: String(message.chatId),
          reactorSourceKey: reaction.isFromMe ? null : `imessage:${reaction.reactorIdentifier}`,
          emoji: reaction.emoji,
          timestamp: reaction.timestamp * 1000,
          isActive: true,
        } satisfies ReactionPayload,
        sourceVersion: "imessage-v1",
      });
    }
  }

  for (const call of effectiveCallBatch.calls) {
    const displayName = buildCallConversationLabel(call);
    if (call.remoteSourceKey && !observedContactSourceKeys.has(call.remoteSourceKey)) {
      observedContactSourceKeys.add(call.remoteSourceKey);
      rawEvents.push({
        id: randomUUID(),
        platform: "imessage",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: call.remoteAddress ?? call.sourceCallKey,
        observedAt: observedBase + call.pk,
        dedupeKey: dedupeKey(`imessage:call-contact:${call.remoteSourceKey}`),
        payload: {
          sourceEntityKey: call.remoteSourceKey,
          fields: {
            display_name: displayName,
          },
          handles: call.remoteAddress
            ? [
                {
                  type: guessHandleType(call.remoteAddress),
                  value: call.remoteAddress,
                  deterministic: true,
                },
              ]
            : [],
        } satisfies ContactObservationPayload,
        sourceVersion: "imessage-v1",
      });
    }

    if (
      call.syntheticConversation &&
      !observedConversationSourceKeys.has(call.sourceConversationKey)
    ) {
      observedConversationSourceKeys.add(call.sourceConversationKey);
      rawEvents.push({
        id: randomUUID(),
        platform: "imessage",
        accountKey: "local",
        entityKind: "conversation",
        eventKind: "observed",
        conversationExternalId: call.sourceConversationKey,
        observedAt: observedBase + call.pk,
        dedupeKey: dedupeKey(`imessage:call-conversation:${call.sourceConversationKey}`),
        payload: {
          sourceConversationKey: call.sourceConversationKey,
          conversationType: "dm",
          displayName,
          service: call.provider,
          participants: call.remoteSourceKey ? [{ sourceEntityKey: call.remoteSourceKey }] : [],
        } satisfies ConversationObservationPayload,
        sourceVersion: "imessage-v1",
      });
    }

    rawEvents.push({
      id: randomUUID(),
      platform: "imessage",
      accountKey: "local",
      entityKind: "call",
      eventKind: "observed",
      externalEntityId: call.sourceCallKey,
      conversationExternalId: call.sourceConversationKey,
      occurredAt: call.startedAt,
      observedAt: observedBase + call.pk,
      dedupeKey: dedupeKey(`imessage:call:${call.sourceCallKey}`),
      payload: {
        sourceCallKey: call.sourceCallKey,
        sourceConversationKey: call.sourceConversationKey,
        provider: call.provider,
        providerCallType: call.providerCallType,
        direction: call.direction,
        medium: call.medium,
        status: call.status,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        durationSeconds: call.durationSeconds,
        initiatorSourceKey: call.direction === "incoming" ? call.remoteSourceKey : null,
        primaryRemoteSourceKey: call.remoteSourceKey,
        remoteAddress: call.remoteAddress,
        remoteDisplayName: call.remoteDisplayName,
        disconnectedCause: call.disconnectedCause,
        metadata: {
          syntheticConversation: call.syntheticConversation,
        },
      } satisfies CallPayload,
      sourceVersion: "imessage-v1",
    });
  }

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor: { rowId: batch.cursor, callPk: effectiveCallBatch.cursor },
    syncMode: (cursor.rowId > 0 || cursor.callPk > 0) && !hasMore ? "incremental" : "full",
    hasMore,
  };
}

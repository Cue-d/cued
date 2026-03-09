import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import type { ImsSyncBatch } from "../adapters/imessage/types.js";
import type { SyncBundle } from "../adapters/types.js";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
  ReactionPayload,
  SourceAccountInput,
} from "../types/provider.js";
import { resolveMacOSNativeBinary } from "./native-binary.js";

const DEFAULT_IMESSAGE_BATCH_LIMIT = 2_000;

function dedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function guessHandleType(identifier: string): string {
  if (identifier.includes("@")) return "email";
  if (/^[+]?\d[\d\s()-]{5,}$/.test(identifier)) return "phone";
  return "imessage_handle";
}

type IMessageLoader =
  | { kind: "native"; path: string }
  | { kind: "ts"; path: string };

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
  limit?: number;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): SyncBundle {
  const limit = options?.limit ?? DEFAULT_IMESSAGE_BATCH_LIMIT;
  const loader = resolveIMessageLoader(options?.env ?? process.env, options?.repoRoot);
  const batch =
    loader.kind === "native"
      ? loadBatchFromNativeBinary(loader.path, options)
      : loadBatchFromTypeScript(options);
  const hasMore = batch.fetchedCount >= limit;
  const observedBase = Date.now();

  const sourceAccounts: SourceAccountInput[] = [
    { platform: "imessage", accountKey: "local", displayName: "Messages" },
  ];

  const rawEvents: SyncBundle["rawEvents"] = [];

  for (const handle of batch.handles) {
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
      eventKind: "message_created",
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
        contentOriginal: message.text ?? "",
        contentCurrent: message.text ?? "",
        statusDelivery: message.status,
        readAt: message.readAt ? message.readAt * 1000 : null,
        isEdited: false,
        isDeleted: false,
        hasAttachments: message.hasAttachments,
        attachments: [],
      } satisfies MessagePayload,
      sourceVersion: "imessage-v1",
    });

    for (const reaction of message.reactions) {
      rawEvents.push({
        id: randomUUID(),
        platform: "imessage",
        accountKey: "local",
        entityKind: "reaction",
        eventKind: "reaction_added",
        externalEntityId: `${message.guid}:${reaction.reactorIdentifier}:${reaction.emoji}`,
        conversationExternalId: String(message.chatId),
        occurredAt: reaction.timestamp * 1000,
        observedAt: observedBase + message.id + reaction.timestamp,
        dedupeKey: dedupeKey(`imessage:reaction:${message.guid}:${reaction.reactorIdentifier}:${reaction.emoji}:${reaction.timestamp}`),
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

  return {
    sourceAccounts,
    rawEvents,
    sourceCursor: { rowId: batch.cursor },
    syncMode:
      options?.lastRowId && options.lastRowId > 0 && !hasMore
        ? "incremental"
        : "full",
    hasMore,
  };
}

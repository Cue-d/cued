/**
 * Signal sync operations.
 * Handles syncing Signal messages from Electron/signal-cli to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizePhone } from "@cued/shared";
import {
  getOrCreateContact,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
  getOrCreateIntegration,
  incrementSyncCursorStat,
  logSyncError,
} from "./shared";
import { batchFetchConversations, batchFetchMessages } from "./batchUtils";

// ============================================================================
// Validators
// ============================================================================

export const signalMessageInput = v.object({
  messageId: v.string(),
  threadId: v.string(),
  threadType: v.union(v.literal("dm"), v.literal("group")),
  threadName: v.optional(v.string()),
  text: v.string(),
  sentAt: v.number(),
  isFromMe: v.boolean(),
  senderHandle: v.optional(v.string()),
  senderName: v.optional(v.string()),
  peerHandle: v.optional(v.string()),
});

export const signalMessagesBatchInput = v.object({
  messages: v.array(signalMessageInput),
});

export type SignalMessageInput = Infer<typeof signalMessageInput>;

function isLikelyPhone(value: string): boolean {
  return /^[+]?[\d\s()-]{6,}$/.test(value.trim());
}

function getSignalHandleInput(handle: string): {
  value: string;
  type: "phone" | "signal_id";
} {
  if (isLikelyPhone(handle)) {
    return { value: normalizePhone(handle) || handle, type: "phone" };
  }
  return { value: handle, type: "signal_id" };
}

async function getOrCreateSignalContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: string,
  displayName?: string
): Promise<Id<"contacts"> | undefined> {
  const result = await getOrCreateContact(
    ctx,
    userId,
    "signal",
    [getSignalHandleInput(handle)],
    displayName || handle
  );
  return result?.contactId;
}

/**
 * Internal sync logic for Signal messages.
 */
export async function syncSignalMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: SignalMessageInput[]
) {
  const result = {
    messagesCount: 0,
    newMessages: 0,
    skippedMessages: 0,
    conversationsUpserted: 0,
    errors: [] as string[],
  };

  if (messages.length === 0) {
    return result;
  }

  const messagesByThread = new Map<string, SignalMessageInput[]>();
  for (const message of messages) {
    const existing = messagesByThread.get(message.threadId) ?? [];
    existing.push(message);
    messagesByThread.set(message.threadId, existing);
  }

  const threadIds = [...messagesByThread.keys()];
  const existingConversations = await batchFetchConversations(ctx, userId, "signal", threadIds);
  const conversationMap = new Map(
    existingConversations.map((conversation) => [
      conversation.platformConversationId,
      conversation,
    ])
  );
  const existingLastMessageAt = new Map(
    existingConversations
      .filter((conversation) => conversation.lastMessageAt !== undefined)
      .map((conversation) => [conversation._id, conversation.lastMessageAt!])
  );

  const existingMessages = await batchFetchMessages(
    ctx,
    userId,
    "signal",
    messages.map((m) => m.messageId)
  );
  const existingMessageIds = new Set(existingMessages.map((m) => m.platformMessageId));

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConversations = new Set<Id<"conversations">>();
  const outgoingConversations = new Set<Id<"conversations">>();

  for (const [threadId, threadMessages] of messagesByThread) {
    let conversation = conversationMap.get(threadId);
    const sample = threadMessages[0];
    const participantIds = new Set<Id<"contacts">>(conversation?.participantContactIds ?? []);

    // Ensure DM conversation has at least one contact participant.
    if (sample.threadType === "dm") {
      const peerHandle =
        sample.peerHandle ||
        threadMessages.find((msg) => !msg.isFromMe)?.senderHandle;

      if (peerHandle) {
        const contactId = await getOrCreateSignalContact(
          ctx,
          userId,
          peerHandle,
          sample.senderName
        );
        if (contactId) {
          participantIds.add(contactId);
        }
      }
    }

    if (!conversation) {
      const conversationId = await ctx.db.insert("conversations", {
        userId,
        platform: "signal",
        platformConversationId: threadId,
        conversationType: sample.threadType === "group" ? "group" : "dm",
        participantContactIds: [...participantIds],
        unreadCount: 0,
        displayName:
          sample.threadName ||
          (sample.threadType === "dm" ? sample.peerHandle || sample.senderName : undefined),
      });
      conversation = (await ctx.db.get(conversationId))!;
      conversationMap.set(threadId, conversation);
      result.conversationsUpserted++;
    }

    let latestMessage: { text: string; timestamp: number } | null = null;

    for (const message of threadMessages) {
      try {
        if (existingMessageIds.has(message.messageId)) {
          result.skippedMessages++;
          continue;
        }

        let senderContactId: Id<"contacts"> | undefined;

        if (!message.isFromMe) {
          const senderHandle = message.senderHandle || message.peerHandle;
          if (senderHandle) {
            senderContactId = await getOrCreateSignalContact(
              ctx,
              userId,
              senderHandle,
              message.senderName
            );
            if (senderContactId) {
              participantIds.add(senderContactId);
            }
          }
        }

        await ctx.db.insert("messages", {
          userId,
          conversationId: conversation._id,
          platform: "signal",
          content: message.text,
          sentAt: message.sentAt,
          senderContactId,
          isFromMe: message.isFromMe,
          platformMessageId: message.messageId,
        });

        result.newMessages++;
        result.messagesCount++;

        if (!latestMessage || message.sentAt > latestMessage.timestamp) {
          latestMessage = { text: message.text, timestamp: message.sentAt };
        }

        if (message.sentAt >= cutoff) {
          if (message.isFromMe) {
            outgoingConversations.add(conversation._id);
          } else {
            incomingConversations.add(conversation._id);
          }
        }
      } catch (error) {
        result.errors.push(logSyncError("Signal", "sync message", message.messageId, error));
      }
    }

    const patch: {
      participantContactIds?: Id<"contacts">[];
      displayName?: string;
      lastMessageText?: string;
      lastMessageAt?: number;
    } = {};

    if (
      participantIds.size > 0 &&
      participantIds.size !== conversation.participantContactIds.length
    ) {
      patch.participantContactIds = [...participantIds];
    }

    if (!conversation.displayName && sample.threadName) {
      patch.displayName = sample.threadName;
    }

    if (latestMessage) {
      const existingTimestamp = existingLastMessageAt.get(conversation._id);
      if (existingTimestamp === undefined || latestMessage.timestamp > existingTimestamp) {
        patch.lastMessageText = latestMessage.text;
        patch.lastMessageAt = latestMessage.timestamp;
        existingLastMessageAt.set(conversation._id, latestMessage.timestamp);
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(conversation._id, patch);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConversations, "signal");
  await scheduleOutgoingMessageEvents(ctx, userId, outgoingConversations);

  await getOrCreateIntegration(ctx, userId, "signal");
  await incrementSyncCursorStat(
    ctx,
    userId,
    "signal",
    "totalMessagesSynced",
    result.newMessages
  );

  return result;
}

/**
 * Slack sync operations.
 * Handles syncing messages from Slack via Nango to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  scheduleIncomingMessageEvents,
  SEVEN_DAYS_MS,
} from "./shared";

// ============================================================================
// Validators
// ============================================================================

export const slackMessageInput = v.object({
  id: v.string(), // Slack ts (timestamp)
  channelId: v.string(),
  channelType: v.union(
    v.literal("im"),
    v.literal("channel"),
    v.literal("group"),
    v.literal("mpim")
  ),
  channelName: v.optional(v.string()), // Channel name or DM partner name
  userId: v.optional(v.string()), // Slack user ID
  userName: v.optional(v.string()), // Sender display name
  text: v.string(),
  ts: v.string(),
  threadTs: v.optional(v.string()),
  isThreadParent: v.boolean(),
  reactions: v.optional(
    v.array(
      v.object({
        name: v.string(),
        count: v.number(),
        users: v.array(v.string()),
      })
    )
  ),
  isBot: v.boolean(),
  sentAt: v.string(), // ISO date string
});

// ============================================================================
// Types
// ============================================================================

export type SlackMessageInput = Infer<typeof slackMessageInput>;

// ============================================================================
// Slack Sync Implementation
// ============================================================================

/**
 * Internal sync logic for Slack messages.
 */
export async function syncSlackMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: SlackMessageInput[]
) {
  const result = {
    messagesCount: 0,
    conversationsCount: 0,
    errors: [] as string[],
  };

  // Group messages by channel for efficient processing
  const messagesByChannel = new Map<string, SlackMessageInput[]>();
  for (const msg of messages) {
    const existing = messagesByChannel.get(msg.channelId) ?? [];
    existing.push(msg);
    messagesByChannel.set(msg.channelId, existing);
  }

  // Batch fetch existing conversations
  const channelIds = [...messagesByChannel.keys()];
  const existingConversations = await batchFetchSlackConversations(
    ctx,
    userId,
    channelIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // Batch fetch existing messages
  const messageIds = messages.map((m) => m.ts);
  const existingMessages = await batchFetchSlackMessages(ctx, userId, messageIds);
  const existingMessageSet = new Set(existingMessages.map((m) => m.platformMessageId));

  // Process each channel's messages
  for (const [channelId, channelMessages] of messagesByChannel) {
    try {
      // Get or create conversation
      let conversationId = conversationMap.get(channelId);
      const firstMsg = channelMessages[0];

      if (!conversationId) {
        const conversationType = getConversationType(firstMsg.channelType);

        conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "slack",
          platformConversationId: channelId,
          conversationType,
          participantContactIds: [], // Will be populated when we resolve users
          unreadCount: 0,
          displayName: firstMsg.channelName, // Store channel name
        });
        conversationMap.set(channelId, conversationId);
        result.conversationsCount++;
      } else if (firstMsg.channelName) {
        // Update display name if we have one and it's not set
        const existingConv = existingConversations.find(
          (c) => c.platformConversationId === channelId
        );
        if (existingConv && !existingConv.displayName) {
          await ctx.db.patch(conversationId, {
            displayName: firstMsg.channelName,
          });
        }
      }

      // Insert new messages
      let latestMessage: { text: string; timestamp: number } | null = null;

      for (const msg of channelMessages) {
        // Skip if already exists
        if (existingMessageSet.has(msg.ts)) {
          continue;
        }

        // Skip bot messages
        if (msg.isBot) {
          continue;
        }

        // Resolve Slack user to contact (with display name if available)
        let senderContactId: Id<"contacts"> | undefined;
        if (msg.userId) {
          senderContactId = await getOrCreateSlackContact(
            ctx,
            userId,
            msg.userId,
            msg.userName // Pass user display name
          );
        }

        const sentAtMs = new Date(msg.sentAt).getTime();

        // Map reactions to our format
        const reactions = msg.reactions?.map((r) => ({
          emoji: `:${r.name}:`,
          contactId: undefined as Id<"contacts"> | undefined, // TODO: resolve first user
          isFromMe: false,
          timestamp: sentAtMs,
        }));

        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "slack",
          content: msg.text,
          sentAt: sentAtMs,
          senderContactId,
          isFromMe: false, // Nango sync only gets messages from others
          platformMessageId: msg.ts,
          // Store thread info
          threadTs: msg.threadTs,
          isThreadParent: msg.isThreadParent,
          reactions: reactions && reactions.length > 0 ? reactions : undefined,
        });

        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || sentAtMs > latestMessage.timestamp) {
          latestMessage = { text: msg.text, timestamp: sentAtMs };
        }
      }

      // Update conversation lastMessage
      if (latestMessage) {
        await ctx.db.patch(conversationId, {
          lastMessageText: latestMessage.text,
          lastMessageAt: latestMessage.timestamp,
        });
      }
    } catch (e) {
      result.errors.push(`Failed to sync channel ${channelId}: ${e}`);
    }
  }

  // Schedule action analysis for new incoming Slack messages (event-driven)
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();

  for (const [channelId, channelMessages] of messagesByChannel) {
    const conversationId = conversationMap.get(channelId);
    if (!conversationId) continue;

    const hasRecentMessage = channelMessages.some(
      (msg) => new Date(msg.sentAt).getTime() >= cutoff
    );
    if (hasRecentMessage) {
      incomingConvos.add(conversationId);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "slack");

  return result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map Slack channel type to our conversation type.
 */
function getConversationType(
  channelType: "im" | "channel" | "group" | "mpim"
): "dm" | "group" | "channel" {
  switch (channelType) {
    case "im":
      return "dm";
    case "mpim":
    case "group":
      return "group";
    case "channel":
      return "channel";
  }
}

/**
 * Get or create a contact for a Slack user ID.
 * Also updates display name if we have a better one.
 */
async function getOrCreateSlackContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  displayName?: string
): Promise<Id<"contacts">> {
  // Check if we already have a handle for this Slack user
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", slackUserId)
    )
    .unique();

  if (existingHandle) {
    // Update display name if we have a better one (not just a Slack user ID)
    if (displayName) {
      const existingContact = await ctx.db.get(existingHandle.contactId);
      if (
        existingContact &&
        existingContact.displayName.startsWith("U") &&
        existingContact.displayName === slackUserId
      ) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create placeholder contact with display name or Slack user ID
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || slackUserId,
  });

  // Create handle for Slack user ID
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "slack_id",
    handle: slackUserId,
    platform: "slack",
  });

  return contactId;
}

// ============================================================================
// Batch Fetch Helpers
// ============================================================================

/**
 * Batch fetch existing Slack conversations by channel ID.
 */
async function batchFetchSlackConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  channelIds: string[]
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  const batchSize = 50;
  for (let i = 0; i < channelIds.length; i += batchSize) {
    const batch = channelIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "slack")
            .eq("platformConversationId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((c): c is Doc<"conversations"> => c !== null));
  }

  return results;
}

/**
 * Batch fetch existing Slack messages by timestamp.
 */
async function batchFetchSlackMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageTs: string[]
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  const batchSize = 50;
  for (let i = 0; i < messageTs.length; i += batchSize) {
    const batch = messageTs.slice(i, i + batchSize);
    const promises = batch.map((ts) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q.eq("userId", userId).eq("platform", "slack").eq("platformMessageId", ts)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((m): m is Doc<"messages"> => m !== null));
  }

  return results;
}

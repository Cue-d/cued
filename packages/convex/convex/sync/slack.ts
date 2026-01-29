/**
 * Slack sync operations for native Electron integration.
 *
 * Uses browser session tokens (xoxc- + d cookie) for:
 * - Proper isFromMe detection via slackUserId comparison
 * - Conversation-based contact creation (no bulk workspace import)
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getOrCreateContact,
  type GetOrCreateContactResult,
  scheduleIncomingMessageEvents,
  SEVEN_DAYS_MS,
  BATCH_SIZE,
  logSyncError,
  isSlackBot,
} from "./shared";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get or create a contact for a Slack user ID.
 * Uses unified getOrCreateContact from shared.ts.
 */
async function getOrCreateSlackContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  displayName?: string
): Promise<GetOrCreateContactResult | undefined> {
  return getOrCreateContact(
    ctx,
    userId,
    "slack",
    [{ value: slackUserId, type: "slack_id" }],
    displayName || slackUserId
  );
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

  for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
    const batch = channelIds.slice(i, i + BATCH_SIZE);
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

  for (let i = 0; i < messageTs.length; i += BATCH_SIZE) {
    const batch = messageTs.slice(i, i + BATCH_SIZE);
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

// ============================================================================
// Native Slack Sync (Electron)
// ============================================================================

/**
 * Input validator for native Slack conversations.
 */
export const nativeSlackConversationInput = v.object({
  id: v.string(), // Channel ID
  name: v.optional(v.string()), // Channel name
  isChannel: v.boolean(),
  isIm: v.boolean(),
  isMpim: v.boolean(),
  isPrivate: v.boolean(),
  isArchived: v.boolean(),
  userId: v.optional(v.string()), // DM partner user ID
  unreadCount: v.number(),
  lastRead: v.optional(v.string()),
  latestTs: v.optional(v.string()),
  latestText: v.optional(v.string()),
});

export type NativeSlackConversationInput = Infer<typeof nativeSlackConversationInput>;

/**
 * Input validator for native Slack messages.
 */
export const nativeSlackMessageInput = v.object({
  channelId: v.string(),
  ts: v.string(),
  text: v.string(),
  userId: v.string(), // Sender Slack user ID
  userName: v.optional(v.string()), // Sender display name (if known)
  threadTs: v.optional(v.string()),
  isThreadParent: v.boolean(),
  replyCount: v.number(),
  reactions: v.optional(
    v.array(
      v.object({
        name: v.string(),
        count: v.number(),
        users: v.array(v.string()),
      })
    )
  ),
});

/**
 * Input validator for mentioned Slack users (for contact creation).
 */
export const slackMentionedUserInput = v.object({
  slackUserId: v.string(),
  displayName: v.string(),
  realName: v.optional(v.string()),
  email: v.optional(v.string()),
});

export type NativeSlackMessageInput = Infer<typeof nativeSlackMessageInput>;
export type SlackMentionedUserInput = Infer<typeof slackMentionedUserInput>;

/**
 * Sync conversations from native Slack integration (Electron).
 * Creates contacts from DM participants only - no bulk workspace import.
 */
export async function syncSlackConversationsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  teamId: string,
  conversations: NativeSlackConversationInput[]
) {
  const result = {
    conversationsCount: 0,
    contactsCreated: 0,
    errors: [] as string[],
  };

  for (const conv of conversations) {
    try {
      // Determine conversation type
      let conversationType: "dm" | "group" | "channel";
      if (conv.isIm) {
        conversationType = "dm";
      } else if (conv.isMpim) {
        conversationType = "group";
      } else {
        conversationType = "channel";
      }

      // Check if conversation exists
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "slack")
            .eq("platformConversationId", conv.id)
        )
        .unique();

      // For DMs, create contact for the other user
      let participantContactIds: Id<"contacts">[] = [];
      if (conv.isIm && conv.userId) {
        const contactResult = await getOrCreateSlackContact(ctx, userId, conv.userId);
        if (contactResult) {
          participantContactIds = [contactResult.contactId];
          if (contactResult.created) result.contactsCreated++;
        }
      }

      // Build display name
      let displayName = conv.name;
      if (!displayName && conv.isIm && participantContactIds.length > 0) {
        // Get contact display name for DM
        const contact = await ctx.db.get(participantContactIds[0]);
        displayName = contact?.displayName;
      }

      // DMs and group DMs are always considered "participated" since user is a direct participant
      // Channels start as not participated until user sends a message or reacts
      const isDirectMessage = conv.isIm || conv.isMpim;

      if (existing) {
        // Update existing conversation
        // Always update conversationType to fix any misclassification from message sync fallback
        // Only set userParticipated if not already true (don't downgrade)
        const updateFields: Record<string, unknown> = {
          conversationType, // Always update - may have been created as "channel" by message sync fallback
          unreadCount: conv.unreadCount,
          displayName: displayName ?? existing.displayName,
          lastMessageText: conv.latestText ?? existing.lastMessageText,
          lastMessageAt: conv.latestTs ? parseSlackTs(conv.latestTs) : existing.lastMessageAt,
          participantContactIds:
            participantContactIds.length > 0 ? participantContactIds : existing.participantContactIds,
          workspaceId: teamId, // Ensure workspaceId is set for multi-workspace support
        };
        // Set userParticipated for DMs if not already set (or if type was previously wrong)
        if (isDirectMessage && existing.userParticipated !== true) {
          updateFields.userParticipated = true;
        }
        await ctx.db.patch(existing._id, updateFields);
      } else {
        // Create new conversation
        await ctx.db.insert("conversations", {
          userId,
          platform: "slack",
          platformConversationId: conv.id,
          conversationType,
          participantContactIds,
          unreadCount: conv.unreadCount,
          displayName,
          lastMessageText: conv.latestText,
          lastMessageAt: conv.latestTs ? parseSlackTs(conv.latestTs) : undefined,
          // DMs are always participated, channels start as false
          userParticipated: isDirectMessage ? true : false,
          workspaceId: teamId, // Store teamId for multi-workspace support
        });
        result.conversationsCount++;
      }
    } catch (e) {
      result.errors.push(logSyncError("Slack", "sync conversation", conv.id, e));
    }
  }

  return result;
}

/**
 * Sync messages from native Slack integration (Electron).
 * Properly detects isFromMe by comparing sender to slackUserId.
 * Optionally creates contacts for mentioned users.
 */
export async function syncSlackNativeMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  teamId: string,
  messages: NativeSlackMessageInput[],
  mentionedUsers?: SlackMentionedUserInput[]
) {
  // TODO: Consider logging skippedBots count at end of sync for debugging visibility.
  // Currently the counter is tracked but not surfaced anywhere useful.
  const result = {
    messagesCount: 0,
    contactsCreated: 0,
    skippedBots: 0,
    errors: [] as string[],
  };

  // Create contacts for all mentioned users first
  // This ensures @mentions can be resolved to contacts even if the user never sent a message
  if (mentionedUsers && mentionedUsers.length > 0) {
    for (const user of mentionedUsers) {
      try {
        const contactResult = await getOrCreateSlackContact(
          ctx,
          userId,
          user.slackUserId,
          user.displayName
        );
        if (contactResult?.created) {
          result.contactsCreated++;
        }
      } catch (e) {
        result.errors.push(logSyncError("Slack", "create contact for mentioned user", user.slackUserId, e));
      }
    }
  }

  // Group by channel for efficiency
  const messagesByChannel = new Map<string, NativeSlackMessageInput[]>();
  for (const msg of messages) {
    const existing = messagesByChannel.get(msg.channelId) ?? [];
    existing.push(msg);
    messagesByChannel.set(msg.channelId, existing);
  }

  // Batch fetch existing messages
  const messageTs = messages.map((m) => m.ts);
  const existingMessages = await batchFetchSlackMessages(ctx, userId, messageTs);
  const existingMessageSet = new Set(existingMessages.map((m) => m.platformMessageId));

  // Batch fetch conversations
  const channelIds = [...messagesByChannel.keys()];
  const existingConversations = await batchFetchSlackConversations(ctx, userId, channelIds);
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );
  // Track existing lastMessageAt to avoid overwriting with older timestamps
  const existingLastMessageAt = new Map(
    existingConversations
      .filter((c) => c.lastMessageAt !== undefined)
      .map((c) => [c._id, c.lastMessageAt!])
  );

  // Track conversations where user has participated (sent message or reacted)
  const participatedConversations = new Set<Id<"conversations">>();

  for (const [channelId, channelMessages] of messagesByChannel) {
    let conversationId = conversationMap.get(channelId);

    // Create conversation if it doesn't exist (shouldn't happen if sync order is correct)
    if (!conversationId) {
      conversationId = await ctx.db.insert("conversations", {
        userId,
        platform: "slack",
        platformConversationId: channelId,
        conversationType: "channel", // Default, will be updated by conversation sync
        participantContactIds: [],
        unreadCount: 0,
        userParticipated: false, // Will be updated if user message found
        workspaceId: teamId, // Store teamId for multi-workspace support
      });
      conversationMap.set(channelId, conversationId);
    }

    let latestMessage: { text: string; timestamp: number } | null = null;

    for (const msg of channelMessages) {
      // Skip if already exists
      if (existingMessageSet.has(msg.ts)) {
        continue;
      }

      // Skip bot messages
      if (isSlackBot(msg.userId)) {
        result.skippedBots++;
        continue;
      }

      try {
        const isFromMe = msg.userId === slackUserId;
        const sentAtMs = parseSlackTs(msg.ts);

        // Only create contact for non-me senders
        let senderContactId: Id<"contacts"> | undefined;
        if (!isFromMe) {
          const contactResult = await getOrCreateSlackContact(
            ctx,
            userId,
            msg.userId,
            msg.userName // Pass display name if available
          );
          senderContactId = contactResult?.contactId;
        }

        // Map reactions and check if user reacted
        const userReacted = msg.reactions?.some((r) => r.users.includes(slackUserId)) ?? false;
        const reactions = msg.reactions?.map((r) => ({
          emoji: `:${r.name}:`,
          contactId: undefined as Id<"contacts"> | undefined,
          isFromMe: r.users.includes(slackUserId),
          timestamp: sentAtMs,
        }));

        // Track participation if user sent message or reacted
        if (isFromMe || userReacted) {
          participatedConversations.add(conversationId);
        }

        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "slack",
          content: msg.text,
          sentAt: sentAtMs,
          senderContactId,
          isFromMe,
          platformMessageId: msg.ts,
          threadTs: msg.threadTs,
          isThreadParent: msg.isThreadParent,
          reactions: reactions && reactions.length > 0 ? reactions : undefined,
        });

        result.messagesCount++;

        // Track latest for conversation update
        if (!latestMessage || sentAtMs > latestMessage.timestamp) {
          latestMessage = { text: msg.text, timestamp: sentAtMs };
        }
      } catch (e) {
        result.errors.push(logSyncError("Slack", "sync message", msg.ts, e));
      }
    }

    // Update conversation lastMessage (only if newer than existing)
    // This prevents older message batches from overwriting newer timestamps
    if (latestMessage) {
      const existingTimestamp = existingLastMessageAt.get(conversationId);
      if (existingTimestamp === undefined || latestMessage.timestamp > existingTimestamp) {
        await ctx.db.patch(conversationId, {
          lastMessageText: latestMessage.text,
          lastMessageAt: latestMessage.timestamp,
        });
        // Update tracking map for subsequent batches within same sync cycle
        existingLastMessageAt.set(conversationId, latestMessage.timestamp);
      }
    }
  }

  // Schedule action analysis for incoming messages
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();

  for (const [channelId, channelMessages] of messagesByChannel) {
    const conversationId = conversationMap.get(channelId);
    if (!conversationId) continue;

    // Only schedule for conversations with recent non-me, non-bot messages
    const hasRecentIncoming = channelMessages.some(
      (msg) =>
        msg.userId !== slackUserId &&
        !isSlackBot(msg.userId) &&
        parseSlackTs(msg.ts) >= cutoff
    );
    if (hasRecentIncoming) {
      incomingConvos.add(conversationId);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "slack");

  // Update userParticipated for channels where user sent messages or reacted
  for (const conversationId of participatedConversations) {
    const conversation = await ctx.db.get(conversationId);
    // Only update channels (DMs are already marked as participated during conversation sync)
    if (conversation && conversation.conversationType === "channel" && !conversation.userParticipated) {
      await ctx.db.patch(conversationId, { userParticipated: true });
    }
  }

  return result;
}

/**
 * Parse Slack timestamp (ts) to milliseconds.
 * Slack timestamps are in format "1234567890.123456" (seconds.microseconds).
 * Falls back to current time if parsing fails.
 */
function parseSlackTs(ts: string): number {
  if (!ts || typeof ts !== "string") {
    console.warn(`[Slack Sync] Invalid timestamp: ${ts}, using current time`);
    return Date.now();
  }

  try {
    const [seconds, microseconds = "0"] = ts.split(".");
    const parsedSeconds = parseInt(seconds, 10);
    const parsedMicroseconds = parseInt(microseconds, 10);

    if (isNaN(parsedSeconds)) {
      console.warn(`[Slack Sync] Failed to parse seconds from timestamp: ${ts}`);
      return Date.now();
    }

    const microPart = isNaN(parsedMicroseconds) ? 0 : Math.floor(parsedMicroseconds / 1000);
    return parsedSeconds * 1000 + microPart;
  } catch {
    console.warn(`[Slack Sync] Error parsing timestamp: ${ts}, using current time`);
    return Date.now();
  }
}

/**
 * Slack sync operations.
 *
 * Supports two modes:
 * 1. Nango sync (legacy): syncSlackMessagesInternal - isFromMe always false
 * 2. Native sync (new): syncSlackConversationsInternal/syncSlackNativeMessagesInternal
 *    - Uses browser session tokens (xoxc- + d cookie)
 *    - Proper isFromMe detection via slackUserId comparison
 *    - Conversation-based contact creation (no bulk workspace import)
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
          const contactResult = await getOrCreateSlackContact(
            ctx,
            userId,
            msg.userId,
            msg.userName // Pass user display name
          );
          senderContactId = contactResult.contactId;
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
 * Result from getOrCreateSlackContact indicating if a new contact was created.
 */
interface GetOrCreateContactResult {
  contactId: Id<"contacts">;
  created: boolean;
}

/**
 * Get or create a contact for a Slack user ID.
 * Also updates display name if we have a better one.
 * Returns both the contactId and whether a new contact was created.
 */
async function getOrCreateSlackContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  displayName?: string
): Promise<GetOrCreateContactResult> {
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
    return { contactId: existingHandle.contactId, created: false };
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

  return { contactId, created: true };
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
        participantContactIds = [contactResult.contactId];
        if (contactResult.created) result.contactsCreated++;
      }

      // Build display name
      let displayName = conv.name;
      if (!displayName && conv.isIm && participantContactIds.length > 0) {
        // Get contact display name for DM
        const contact = await ctx.db.get(participantContactIds[0]);
        displayName = contact?.displayName;
      }

      if (existing) {
        // Update existing conversation
        await ctx.db.patch(existing._id, {
          unreadCount: conv.unreadCount,
          displayName: displayName ?? existing.displayName,
          lastMessageText: conv.latestText ?? existing.lastMessageText,
          lastMessageAt: conv.latestTs ? parseSlackTs(conv.latestTs) : existing.lastMessageAt,
          participantContactIds:
            participantContactIds.length > 0 ? participantContactIds : existing.participantContactIds,
        });
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
        });
        result.conversationsCount++;
      }
    } catch (e) {
      result.errors.push(`Failed to sync conversation ${conv.id}: ${e}`);
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
  messages: NativeSlackMessageInput[],
  mentionedUsers?: SlackMentionedUserInput[]
) {
  const result = {
    messagesCount: 0,
    contactsCreated: 0,
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
        if (contactResult.created) {
          result.contactsCreated++;
        }
      } catch (e) {
        result.errors.push(`Failed to create contact for mentioned user ${user.slackUserId}: ${e}`);
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
      });
      conversationMap.set(channelId, conversationId);
    }

    let latestMessage: { text: string; timestamp: number } | null = null;

    for (const msg of channelMessages) {
      // Skip if already exists
      if (existingMessageSet.has(msg.ts)) {
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
          senderContactId = contactResult.contactId;
        }

        // Map reactions
        const reactions = msg.reactions?.map((r) => ({
          emoji: `:${r.name}:`,
          contactId: undefined as Id<"contacts"> | undefined,
          isFromMe: r.users.includes(slackUserId),
          timestamp: sentAtMs,
        }));

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
        result.errors.push(`Failed to sync message ${msg.ts}: ${e}`);
      }
    }

    // Update conversation lastMessage
    if (latestMessage) {
      await ctx.db.patch(conversationId, {
        lastMessageText: latestMessage.text,
        lastMessageAt: latestMessage.timestamp,
      });
    }
  }

  // Schedule action analysis for incoming messages
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();

  for (const [channelId, channelMessages] of messagesByChannel) {
    const conversationId = conversationMap.get(channelId);
    if (!conversationId) continue;

    // Only schedule for conversations with recent non-me messages
    const hasRecentIncoming = channelMessages.some(
      (msg) => msg.userId !== slackUserId && parseSlackTs(msg.ts) >= cutoff
    );
    if (hasRecentIncoming) {
      incomingConvos.add(conversationId);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "slack");

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

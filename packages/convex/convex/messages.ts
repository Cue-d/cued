import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { platformValidator } from "./schema";

interface InboxArgs {
  limit?: number;
  cursor?: string;
  platform?: Doc<"conversations">["platform"];
}

interface InboxResult {
  conversations: Array<{
    _id: Id<"conversations">;
    platform: Doc<"conversations">["platform"];
    platformConversationId: string;
    conversationType: Doc<"conversations">["conversationType"];
    participants: Array<{ _id: Id<"contacts">; displayName: string }>;
    lastMessageText: string | null;
    lastMessageAt: number | null;
    unreadCount: number;
  }>;
  nextCursor: string | null;
}

const EMPTY_INBOX: InboxResult = { conversations: [], nextCursor: null };

/**
 * Shared inbox fetching logic used by both authenticated and test queries.
 */
async function fetchInbox(
  ctx: QueryCtx,
  userId: Id<"users">,
  args: InboxArgs
): Promise<InboxResult> {
  const limit = args.limit ?? 50;
  const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : undefined;

  // Build query with optional cursor filter
  const conversationsQuery = ctx.db
    .query("conversations")
    .withIndex("by_user_last_message", (q) => {
      const base = q.eq("userId", userId);
      return cursorTimestamp !== undefined
        ? base.lt("lastMessageAt", cursorTimestamp)
        : base;
    })
    .order("desc");

  // Fetch one extra to determine if there's a next page
  const conversations = await conversationsQuery.take(limit + 1);

  // Filter by platform if specified
  const filtered = args.platform
    ? conversations.filter((c) => c.platform === args.platform)
    : conversations;

  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;

  // Resolve participant contact names
  const conversationsWithParticipants = await Promise.all(
    page.map(async (conversation) => {
      const participants = await resolveParticipants(
        ctx,
        conversation.participantContactIds
      );

      return {
        _id: conversation._id,
        platform: conversation.platform,
        platformConversationId: conversation.platformConversationId,
        conversationType: conversation.conversationType,
        participants,
        lastMessageText: conversation.lastMessageText ?? null,
        lastMessageAt: conversation.lastMessageAt ?? null,
        unreadCount: conversation.unreadCount,
      };
    })
  );

  const lastItem = page[page.length - 1];
  const nextCursor =
    hasMore && lastItem?.lastMessageAt
      ? String(lastItem.lastMessageAt)
      : null;

  return { conversations: conversationsWithParticipants, nextCursor };
}

/**
 * Get inbox (list of conversations) with pagination.
 *
 * Returns conversations sorted by lastMessageAt descending.
 * Includes participant contact names for display.
 */
export const getInbox = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    platform: v.optional(platformValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return EMPTY_INBOX;
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) {
      return EMPTY_INBOX;
    }

    return fetchInbox(ctx, user._id, args);
  },
});

const EMPTY_MESSAGES = { messages: [], nextCursor: null };

/**
 * Get messages for a specific conversation with pagination.
 *
 * Returns messages sorted by sentAt descending (newest first).
 * Includes sender contact info.
 */
export const getMessages = query({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return EMPTY_MESSAGES;
    }

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) {
      return EMPTY_MESSAGES;
    }

    // Verify conversation belongs to user
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== user._id) {
      return EMPTY_MESSAGES;
    }

    const limit = args.limit ?? 50;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : undefined;

    // Build query with optional cursor filter
    const messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => {
        const base = q.eq("conversationId", args.conversationId);
        return cursorTimestamp !== undefined
          ? base.lt("sentAt", cursorTimestamp)
          : base;
      })
      .order("desc");

    // Fetch one extra to determine if there's a next page
    const messages = await messagesQuery.take(limit + 1);

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;

    // Resolve sender contacts and attachment URLs
    const messagesWithSender = await Promise.all(
      page.map(async (message) => {
        const sender = message.senderContactId
          ? await ctx.db.get(message.senderContactId)
          : null;

        // Resolve attachment storage URLs
        const attachments = message.attachments?.length
          ? await Promise.all(
              message.attachments.map(async (att) => ({
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                url: (await ctx.storage.getUrl(att.storageId)) ?? "",
                thumbnailUrl: att.thumbnailStorageId
                  ? ((await ctx.storage.getUrl(att.thumbnailStorageId)) ?? null)
                  : null,
              }))
            )
          : undefined;

        return {
          _id: message._id,
          content: message.content,
          sentAt: message.sentAt,
          isFromMe: message.isFromMe,
          platform: message.platform,
          sender: sender
            ? { _id: sender._id, displayName: sender.displayName }
            : null,
          attachments,
        };
      })
    );

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem?.sentAt ? String(lastItem.sentAt) : null;

    return { messages: messagesWithSender, nextCursor };
  },
});

/**
 * Resolve an array of contact IDs to participant info.
 */
async function resolveParticipants(
  ctx: QueryCtx,
  contactIds: Id<"contacts">[]
): Promise<Array<{ _id: Id<"contacts">; displayName: string }>> {
  const contacts = await Promise.all(
    contactIds.map((id) => ctx.db.get(id))
  );

  return contacts
    .filter((c): c is Doc<"contacts"> => c !== null)
    .map((c) => ({
      _id: c._id,
      displayName: c.displayName,
    }));
}

/**
 * Find user by WorkOS ID.
 */
function findUserByWorkosId(
  ctx: QueryCtx,
  workosUserId: string
): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_workos_id", (q) => q.eq("workosUserId", workosUserId))
    .unique();
}


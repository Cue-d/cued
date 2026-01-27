import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";
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
    displayName: string | null;
    participants: Array<{ _id: Id<"contacts">; displayName: string }>;
    lastMessageText: string | null;
    lastMessageAt: number | null;
    unreadCount: number;
    workspaceId: string | null;
  }>;
  nextCursor: string | null;
}

const EMPTY_INBOX: InboxResult = { conversations: [], nextCursor: null };

/**
 * Get sort key for a conversation (lastMessageAt or _creationTime as fallback).
 */
function getConversationSortKey(c: Doc<"conversations">): number {
  return c.lastMessageAt ?? c._creationTime;
}

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

  // Use platform-specific index when filtering, otherwise get all user conversations
  // This ensures we include conversations without lastMessageAt
  const conversationsQuery = args.platform
    ? ctx.db
        .query("conversations")
        .withIndex("by_user_platform", (q) =>
          q.eq("userId", userId).eq("platform", args.platform!)
        )
    : ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("userId", userId));

  // Fetch all matching conversations (we'll sort and paginate in memory)
  const allConversations = await conversationsQuery.collect();

  // Filter out Slack channels where user hasn't participated
  // DMs/group DMs are always shown; channels require userParticipated=true
  const filteredConversations = allConversations.filter((c) => {
    // Non-Slack platforms: always show
    if (c.platform !== "slack") return true;
    // DMs and group DMs: always show
    if (c.conversationType === "dm" || c.conversationType === "group") return true;
    // Slack channels: only show if user has participated
    return c.userParticipated === true;
  });

  // Sort by lastMessageAt descending (use _creationTime as fallback)
  const sorted = filteredConversations.sort(
    (a, b) => getConversationSortKey(b) - getConversationSortKey(a)
  );

  // Apply cursor filter if provided
  const afterCursor = cursorTimestamp
    ? sorted.filter((c) => getConversationSortKey(c) < cursorTimestamp)
    : sorted;

  const hasMore = afterCursor.length > limit;
  const page = hasMore ? afterCursor.slice(0, limit) : afterCursor;

  // Resolve participant contact names and handles
  const conversationsWithParticipants = await Promise.all(
    page.map(async (conversation) => {
      // Include handles for DM conversations (needed for sending messages)
      const isDm = conversation.conversationType === "dm";
      const participants = await resolveParticipants(
        ctx,
        conversation.participantContactIds,
        isDm ? { includeHandles: true, platform: conversation.platform } : undefined
      );

      // For groups without displayName, build name from participants
      let displayName: string | null = conversation.displayName ?? null;
      if (
        conversation.conversationType !== "dm" &&
        !displayName &&
        participants.length > 0
      ) {
        displayName = participants.map((p) => p.displayName).join(", ");
      }

      return {
        _id: conversation._id,
        platform: conversation.platform,
        platformConversationId: conversation.platformConversationId,
        conversationType: conversation.conversationType,
        displayName,
        participants,
        lastMessageText: conversation.lastMessageText ?? null,
        lastMessageAt: conversation.lastMessageAt ?? null,
        unreadCount: conversation.unreadCount,
        workspaceId: conversation.workspaceId ?? null,
      };
    })
  );

  const lastItem = page[page.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? String(getConversationSortKey(lastItem))
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
    const user = await getAuthenticatedUser(ctx);
    if (!user) return EMPTY_INBOX;

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
    const user = await getAuthenticatedUser(ctx);
    if (!user) return EMPTY_MESSAGES;

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

    // Resolve sender contacts
    const messagesWithSender = await Promise.all(
      page.map(async (message) => {
        const sender = message.senderContactId
          ? await ctx.db.get(message.senderContactId)
          : null;

        return {
          _id: message._id,
          content: message.content,
          sentAt: message.sentAt,
          isFromMe: message.isFromMe,
          platform: message.platform,
          sender: sender
            ? { _id: sender._id, displayName: sender.displayName }
            : null,
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
 * Resolve an array of contact IDs to participant info, optionally including handles.
 */
async function resolveParticipants(
  ctx: QueryCtx,
  contactIds: Id<"contacts">[],
  options?: { includeHandles?: boolean; platform?: string }
): Promise<Array<{ _id: Id<"contacts">; displayName: string; handle?: string }>> {
  const contacts = await Promise.all(
    contactIds.map((id) => ctx.db.get(id))
  );

  const validContacts = contacts.filter((c): c is Doc<"contacts"> => c !== null);

  // Optionally fetch handles for the contacts
  let handleMap = new Map<string, string>();
  if (options?.includeHandles && options?.platform) {
    const handles = await Promise.all(
      validContacts.map(async (c) => {
        const handle = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", c._id))
          .filter((q) => q.eq(q.field("platform"), options.platform))
          .first();
        return { contactId: c._id, handle: handle?.handle ?? null };
      })
    );
    for (const h of handles) {
      if (h.handle) {
        handleMap.set(h.contactId, h.handle);
      }
    }
  }

  return validContacts.map((c) => ({
    _id: c._id,
    displayName: c.displayName,
    handle: handleMap.get(c._id),
  }));
}

/**
 * Get a conversation by ID.
 * Task 5.8: Used by API routes to get conversation details for message sending.
 */
export const getConversationById = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    return {
      _id: conversation._id,
      platform: conversation.platform,
      platformConversationId: conversation.platformConversationId,
      conversationType: conversation.conversationType,
      displayName: conversation.displayName ?? null,
    };
  },
});



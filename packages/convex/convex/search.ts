import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getAuthenticatedUser } from "./lib/auth";

/**
 * Search messages by content using full-text search.
 */
export const searchMessages = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { results: [] };

    const limit = Math.min(args.limit ?? 20, 50);

    const searchQuery = ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => {
        let search = q.search("content", args.query).eq("userId", user._id);
        if (args.conversationId) {
          search = search.eq("conversationId", args.conversationId);
        }
        return search;
      });

    const messages = await searchQuery.take(limit);

    const results = await Promise.all(
      messages.map(async (message) => {
        const [sender, conversation] = await Promise.all([
          message.senderContactId ? ctx.db.get(message.senderContactId) : null,
          ctx.db.get(message.conversationId),
        ]);

        return {
          _id: message._id,
          conversationId: message.conversationId,
          content: message.content,
          sentAt: message.sentAt,
          isFromMe: message.isFromMe,
          platform: message.platform,
          senderName: sender?.displayName ?? (message.isFromMe ? "You" : null),
          conversationName: conversation
            ? await getConversationDisplayName(ctx, conversation)
            : null,
        };
      })
    );

    return { results };
  },
});

/**
 * Search contacts by display name using full-text search.
 */
export const searchContacts = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { results: [] };

    const limit = Math.min(args.limit ?? 20, 50);

    const contacts = await ctx.db
      .query("contacts")
      .withSearchIndex("search_display_name", (q) =>
        q.search("displayName", args.query).eq("userId", user._id)
      )
      .take(limit);

    const results = await Promise.all(
      contacts.map(async (contact) => {
        const handles = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect();

        return {
          _id: contact._id,
          displayName: contact.displayName,
          company: contact.company ?? null,
          notes: contact.notes ?? null,
          importance: contact.importance ?? null,
          handles: handles.map((h) => ({
            type: h.handleType,
            value: h.handle,
            platform: h.platform,
          })),
        };
      })
    );

    return { results };
  },
});

/**
 * Get recent conversations for a user.
 */
export const getRecentConversations = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { results: [] };

    const limit = Math.min(args.limit ?? 10, 50);

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    const results = await Promise.all(
      conversations.map(async (conversation) => ({
        _id: conversation._id,
        platform: conversation.platform,
        conversationType: conversation.conversationType,
        displayName: await getConversationDisplayName(ctx, conversation),
        lastMessageText: conversation.lastMessageText ?? null,
        lastMessageAt: conversation.lastMessageAt ?? null,
        unreadCount: conversation.unreadCount,
      }))
    );

    return { results };
  },
});

async function getConversationDisplayName(
  ctx: QueryCtx,
  conversation: Doc<"conversations">
): Promise<string> {
  if (conversation.participantContactIds.length === 0) {
    return "Unknown";
  }

  const participants = await Promise.all(
    conversation.participantContactIds.slice(0, 3).map((id) => ctx.db.get(id))
  );

  const names = participants
    .filter((p): p is Doc<"contacts"> => p !== null)
    .map((p) => p.displayName);

  if (names.length === 0) {
    return "Unknown";
  }

  if (conversation.participantContactIds.length > 3 && names.length === 3) {
    return `${names.join(", ")} +${conversation.participantContactIds.length - 3}`;
  }

  return names.join(", ");
}

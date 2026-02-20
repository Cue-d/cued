import { v } from "convex/values";
import { normalizeEmail } from "@cued/ai";
import { getPhoneVariants, normalizePhone } from "@cued/shared";
import type { Doc, Id } from "./_generated/dataModel";
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
    const rawQuery = args.query.trim();
    if (!rawQuery) return { results: [] };
    const queryLower = rawQuery.toLowerCase();
    const normalizedEmailQuery = rawQuery.includes("@")
      ? normalizeEmail(rawQuery)
      : "";
    const normalizedPhoneQuery = /\d/.test(rawQuery)
      ? normalizePhone(rawQuery)
      : "";
    const phoneVariants = normalizedPhoneQuery
      ? new Set(
          getPhoneVariants(rawQuery)
            .map((variant) => variant.toLowerCase())
            .filter(Boolean),
        )
      : new Set<string>();
    const handleContainsCandidates = new Set(
      [queryLower, normalizedEmailQuery.toLowerCase(), normalizedPhoneQuery.toLowerCase()].filter(
        Boolean,
      ),
    );
    const handleContainsCandidatesList = [...handleContainsCandidates];

    const nameMatches = await ctx.db
      .query("contacts")
      .withSearchIndex("search_display_name", (q) =>
        q.search("displayName", rawQuery).eq("userId", user._id)
      )
      .take(limit);

    const allHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const handlesByContactId = new Map<Id<"contacts">, (typeof allHandles)[number][]>();
    for (const handle of allHandles) {
      const handles = handlesByContactId.get(handle.contactId);
      if (handles) {
        handles.push(handle);
      } else {
        handlesByContactId.set(handle.contactId, [handle]);
      }
    }

    const matchesByContactId = new Map<
      Id<"contacts">,
      {
        contact?: Doc<"contacts">;
        score: number;
        matchedHandle?: string;
      }
    >();

    for (const contact of nameMatches) {
      const nameLower = contact.displayName.toLowerCase();
      let score = 400;
      if (nameLower === queryLower) score = 500;
      else if (nameLower.startsWith(queryLower)) score = 450;
      else if (nameLower.includes(queryLower)) score = 420;
      matchesByContactId.set(contact._id, {
        contact,
        score,
      });
    }

    for (const handle of allHandles) {
      const handleLower = handle.handle.toLowerCase();

      let score = 0;
      if (phoneVariants.has(handleLower)) {
        score = 430;
      } else if (
        normalizedEmailQuery &&
        handle.handleType === "email" &&
        handleLower === normalizedEmailQuery.toLowerCase()
      ) {
        score = 430;
      } else if (
        handleContainsCandidatesList.some(
          (candidate) => candidate && handleLower.includes(candidate),
        )
      ) {
        score = 380;
      }

      if (score === 0) continue;

      const existing = matchesByContactId.get(handle.contactId);
      if (!existing || score > existing.score) {
        matchesByContactId.set(handle.contactId, {
          contact: existing?.contact,
          score,
          matchedHandle: handle.handle,
        });
      }
    }

    const contactIdsMissingDocs = [...matchesByContactId.entries()]
      .filter(([, value]) => !value.contact)
      .map(([contactId]) => contactId);

    if (contactIdsMissingDocs.length > 0) {
      const fetchedContacts = await Promise.all(
        contactIdsMissingDocs.map((contactId) => ctx.db.get(contactId)),
      );
      for (const contact of fetchedContacts) {
        if (!contact) continue;
        const existing = matchesByContactId.get(contact._id);
        if (existing) {
          existing.contact = contact;
        }
      }
    }

    const results = [...matchesByContactId.entries()]
      .map(([contactId, match]) => {
        if (!match.contact) return null;
        const handles = handlesByContactId.get(contactId) ?? [];
        return {
          _id: contactId,
          displayName: match.contact.displayName,
          company: match.contact.company ?? null,
          notes: match.contact.notes ?? null,
          importance: match.contact.importance ?? null,
          matchedHandle: match.matchedHandle ?? null,
          handles: handles.map((h) => ({
            type: h.handleType,
            value: h.handle,
            platform: h.platform,
          })),
          _score: match.score,
        };
      })
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort(
        (a, b) =>
          b._score - a._score || a.displayName.localeCompare(b.displayName),
      )
      .slice(0, limit)
      .map(({ _score: _ignored, ...result }) => result);

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

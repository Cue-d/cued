import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { mutation, query, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUser } from "./lib/auth";
import {
  handleTypeValidator,
  mergeSourceValidator,
  platformValidator,
  contactStatusValidator,
  mergeFieldResolutionsValidator,
} from "./schema";
import { scheduleContactMergeCheck } from "./lib/contactMergeScheduling";
import { normalizeHandleValue } from "./lib/normalizeHandle";
import { normalizePublicAvatarUrl } from "./lib/avatar";
import { getContactStatus } from "./lib/contactStatus";
import {
  buildContactHandleDedupKey,
  executeContactMerge,
  type ContactMergeSource,
  type MergeConversationSnapshot,
  type MergeDedupedHandleSnapshot,
  type MergeFieldResolutions,
  type MergePrimaryFieldChanges,
} from "./lib/contactMerge";

// ============================================================================
/** Normalize contact pair IDs so smaller ID is always first. */
export function normalizeContactPair(
  a: Id<"contacts">,
  b: Id<"contacts">,
): [Id<"contacts">, Id<"contacts">] {
  return a < b ? [a, b] : [b, a];
}

/** Check if a contact pair is in the exclusion list. */
export async function isExcludedPair(
  ctx: QueryCtx,
  contact1Id: Id<"contacts">,
  contact2Id: Id<"contacts">,
): Promise<boolean> {
  const [c1, c2] = normalizeContactPair(contact1Id, contact2Id);
  const exclusion = await ctx.db
    .query("contactExclusions")
    .withIndex("by_pair", (q) => q.eq("contact1Id", c1).eq("contact2Id", c2))
    .first();
  return !!exclusion;
}

// ============================================================================
// Contact Queries
// ============================================================================

/**
 * Get all contacts for the current user with their handles.
 * Sorted alphabetically by displayName.
 * Supports search by name and cursor-based pagination.
 * Optimized: batch fetches handles instead of N+1 queries.
 */
export const getContacts = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(
      v.object({
        displayName: v.string(),
        _id: v.id("contacts"),
      }),
    ),
    searchQuery: v.optional(v.string()),
    status: v.optional(contactStatusValidator),
    namedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { contacts: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 50, 100);
    // Treat legacy "dismissed" filter as archived.
    const filterStatus = args.status === "dismissed" ? "archived" : (args.status ?? "active");

    // Fetch contacts - with search or regular query
    const isSearch = args.searchQuery && args.searchQuery.trim().length > 0;
    let rawContacts: Doc<"contacts">[];

    if (isSearch) {
      // Search index can't filter by status, so over-fetch then filter in memory.
      const searchTake = Math.min(500, Math.max(limit + 1, (limit + 1) * 5));
      rawContacts = await ctx.db
        .query("contacts")
        .withSearchIndex("search_display_name", (q) =>
          q.search("displayName", args.searchQuery!).eq("userId", user._id),
        )
        .take(searchTake);
    } else {
      // Use alphabetical index for sorted results
      // When namedOnly, use gte("A") to skip phone numbers/symbols that sort
      // before alphabetic characters — they dominate early pages and get filtered
      // out client-side, leaving the list empty.
      let contactsQuery = ctx.db
        .query("contacts")
        .withIndex("by_user_display_name", (q) => {
          const builder = q.eq("userId", user._id);
          return args.namedOnly ? builder.gte("displayName", "A") : builder;
        });

      contactsQuery = contactsQuery.filter((q) => {
        switch (filterStatus) {
          case "archived":
            return q.or(
              q.eq(q.field("status"), "archived"),
              q.eq(q.field("status"), "dismissed"),
              q.eq(q.field("isDismissed"), true),
            );
          default:
            return q.and(
              q.neq(q.field("status"), "archived"),
              q.neq(q.field("status"), "dismissed"),
              q.neq(q.field("isDismissed"), true),
            );
        }
      });

      // For cursor-based pagination with alphabetical ordering:
      // Skip contacts until we pass the cursor position
      if (args.cursor) {
        contactsQuery = contactsQuery.filter((q) =>
          q.or(
            // displayName > cursor.displayName
            q.gt(q.field("displayName"), args.cursor!.displayName),
            // displayName == cursor.displayName AND _id > cursor._id (tiebreaker)
            q.and(
              q.eq(q.field("displayName"), args.cursor!.displayName),
              q.gt(q.field("_id"), args.cursor!._id),
            ),
          ),
        );
      }

      rawContacts = await contactsQuery.take(limit + 1);
    }

    // Search path still needs in-memory status filter.
    const contacts = isSearch
      ? rawContacts.filter((c) => getContactStatus(c) === filterStatus)
      : rawContacts;
    const hasMore = contacts.length > limit;
    const results = hasMore ? contacts.slice(0, limit) : contacts;
    const cursorSource = hasMore && results.length > 0
      ? results[results.length - 1]
      : null;

    if (results.length === 0) {
      return {
        contacts: [],
        nextCursor: cursorSource
          ? { displayName: cursorSource.displayName, _id: cursorSource._id }
          : null,
      };
    }

    // Batch fetch handles for all contacts in parallel
    const allHandles = await Promise.all(
      results.map((contact) =>
        ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect(),
      ),
    );

    // Build contacts with handles
    const contactsWithHandles = results.map((contact, i) => ({
      ...contact,
      avatarUrl: normalizePublicAvatarUrl(contact.avatarUrl),
      handles: allHandles[i].map((h) => ({
        type: h.handleType,
        value: h.handle,
        platform: h.platform,
      })),
    }));

    return {
      contacts: contactsWithHandles,
      nextCursor: cursorSource
        ? { displayName: cursorSource.displayName, _id: cursorSource._id }
        : null,
    };
  },
});

/**
 * Paginated contacts list for infinite scroll.
 * Returns contacts sorted alphabetically with handles, excluding non-active.
 */
export const listContactsPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user)
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      } as PaginationResult<never>;

    const results = await ctx.db
      .query("contacts")
      .withIndex("by_user_display_name", (q) => q.eq("userId", user._id))
      .filter((q) =>
        q.and(
          q.neq(q.field("isDismissed"), true),
          q.neq(q.field("status"), "dismissed"),
          q.neq(q.field("status"), "archived"),
        ),
      )
      .paginate(args.paginationOpts);

    const enrichedPage = await Promise.all(
      results.page.map(async (contact) => {
        const handles = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect();
        return {
          ...contact,
          avatarUrl: normalizePublicAvatarUrl(contact.avatarUrl),
          handles: handles.map((h) => ({
            type: h.handleType,
            value: h.handle,
            platform: h.platform,
          })),
        };
      }),
    );

    return { ...results, page: enrichedPage };
  },
});

/**
 * Get a single contact with all their handles.
 */
export const getContact = query({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) return null;

    const handles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();

    return {
      ...contact,
      avatarUrl: normalizePublicAvatarUrl(contact.avatarUrl),
      handles: handles.map((h) => ({
        type: h.handleType,
        value: h.handle,
        platform: h.platform,
      })),
    };
  },
});

/**
 * Get contacts alphabetically adjacent to a given contact.
 * Returns a few contacts before and after in the sorted list.
 */
export const getAdjacentContacts = query({
  args: {
    contactId: v.id("contacts"),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { before: [], after: [] };

    const count = Math.min(args.count ?? 3, 10);

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) return { before: [], after: [] };

    const name = contact.displayName;

    // Contacts after (alphabetically)
    const after = await ctx.db
      .query("contacts")
      .withIndex("by_user_display_name", (q) => q.eq("userId", user._id))
      .filter((q) =>
        q.and(
          q.neq(q.field("_id"), args.contactId),
          q.neq(q.field("isDismissed"), true),
          q.neq(q.field("status"), "dismissed"),
          q.neq(q.field("status"), "archived"),
          q.or(
            q.gt(q.field("displayName"), name),
            q.and(
              q.eq(q.field("displayName"), name),
              q.gt(q.field("_id"), args.contactId)
            )
          )
        )
      )
      .take(count);

    // Contacts before (alphabetically, descending)
    const beforeRaw = await ctx.db
      .query("contacts")
      .withIndex("by_user_display_name", (q) => q.eq("userId", user._id))
      .order("desc")
      .filter((q) =>
        q.and(
          q.neq(q.field("_id"), args.contactId),
          q.neq(q.field("isDismissed"), true),
          q.neq(q.field("status"), "dismissed"),
          q.neq(q.field("status"), "archived"),
          q.or(
            q.lt(q.field("displayName"), name),
            q.and(
              q.eq(q.field("displayName"), name),
              q.lt(q.field("_id"), args.contactId)
            )
          )
        )
      )
      .take(count);

    return {
      before: beforeRaw.reverse().map((c) => ({
        _id: c._id,
        displayName: c.displayName,
        company: c.company,
        avatarUrl: normalizePublicAvatarUrl(c.avatarUrl),
      })),
      after: after.map((c) => ({
        _id: c._id,
        displayName: c.displayName,
        company: c.company,
        avatarUrl: normalizePublicAvatarUrl(c.avatarUrl),
      })),
    };
  },
});

/**
 * Get a contact profile with all related data for the detail view.
 * Includes: handles, conversations, recent messages.
 */
export const getContactProfile = query({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return null;

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) return null;

    // Fetch handles
    const handles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();

    // Fetch a bounded slice of recent conversations for this user and filter by participant
    const candidateConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(100);

    const conversations = candidateConversations
      .filter((c) => c.participantContactIds.includes(args.contactId))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .slice(0, 10);

    // Fetch recent messages from these conversations
    const recentMessages = await Promise.all(
      conversations.slice(0, 5).map(async (conv) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
          .order("desc")
          .take(10);
        return messages.map((m) => ({
          ...m,
          conversationDisplayName: conv.displayName,
          conversationPlatform: conv.platform,
        }));
      }),
    );

    // Fetch messages sent by this contact directly
    const messagesByContact = await ctx.db
      .query("messages")
      .withIndex("by_sender_contact", (q) =>
        q.eq("senderContactId", args.contactId),
      )
      .order("desc")
      .take(50);

    // Combine and dedupe messages, sort by sentAt
    const allMessages = [...recentMessages.flat(), ...messagesByContact];
    const uniqueMessages = Array.from(
      new Map(allMessages.map((m) => [m._id, m])).values(),
    ).sort((a, b) => b.sentAt - a.sentAt);

    // Fetch recent actions related to this contact
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(10);

    // Calculate activity stats
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const recentMessageCount = uniqueMessages.filter(
      (m) => m.sentAt > Date.now() - THIRTY_DAYS_MS,
    ).length;

    const MAX_MESSAGE_PREVIEW_CHARS = 200;

    return {
      contact: {
        ...contact,
        avatarUrl: normalizePublicAvatarUrl(contact.avatarUrl),
        handles: handles.map((h) => ({
          type: h.handleType,
          value: h.handle,
          platform: h.platform,
        })),
      },
      conversations: conversations.map((c) => ({
        _id: c._id,
        platform: c.platform,
        displayName: c.displayName,
        lastMessageText: c.lastMessageText,
        lastMessageAt: c.lastMessageAt,
        conversationType: c.conversationType,
      })),
      messages: uniqueMessages.slice(0, 50).map((m) => ({
        _id: m._id,
        content:
          m.content.length > MAX_MESSAGE_PREVIEW_CHARS
            ? `${m.content.slice(0, MAX_MESSAGE_PREVIEW_CHARS)}...`
            : m.content,
        sentAt: m.sentAt,
        isFromMe: m.isFromMe,
        platform: m.platform,
      })),
      actions: actions.map((a) => ({
        _id: a._id,
        type: a.type,
        status: a.status,
        createdAt: a.createdAt,
        completedAt: a.completedAt,
      })),
      stats: {
        totalConversations: conversations.length,
        totalMessages: uniqueMessages.length,
        recentMessageCount,
        lastContactedAt: uniqueMessages[0]?.sentAt ?? null,
        platformsUsed: [...new Set(handles.map((h) => h.platform))],
      },
    };
  },
});

/**
 * Get pending merge suggestions for the current user.
 */
export const getPendingMergeSuggestions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { suggestions: [] };

    // Use limit if provided, otherwise return all (typically < 100)
    const query = ctx.db
      .query("mergeSuggestions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending"),
      )
      .order("desc");

    const suggestions = args.limit
      ? await query.take(args.limit)
      : await query.collect();

    // Fetch contact details for each suggestion
    const enrichedSuggestions = await Promise.all(
      suggestions.map(async (suggestion) => {
        const [contact1, contact2] = await Promise.all([
          getContactWithHandles(ctx, suggestion.contact1Id),
          getContactWithHandles(ctx, suggestion.contact2Id),
        ]);

        return {
          ...suggestion,
          contact1,
          contact2,
        };
      }),
    );

    return { suggestions: enrichedSuggestions };
  },
});

/**
 * Get count of pending merge suggestions.
 */
export const getPendingMergeSuggestionCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return 0;

    const suggestions = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending"),
      )
      .collect();

    return suggestions.length;
  },
});

/**
 * Preview the outcome of merging two contacts.
 * Shows field conflicts, handle movement, and impact counts.
 */
export const mergePreview = query({
  args: {
    primaryContactId: v.id("contacts"),
    secondaryContactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const [primary, secondary] = await Promise.all([
      ctx.db.get(args.primaryContactId),
      ctx.db.get(args.secondaryContactId),
    ]);
    // Contacts can disappear between selection and preview (e.g. merged/deleted in another session).
    // Return null so clients can recover gracefully instead of crashing on a thrown query error.
    if (!primary || primary.userId !== user._id) return null;
    if (!secondary || secondary.userId !== user._id) return null;

    const [primaryHandles, secondaryHandles] = await Promise.all([
      ctx.db.query("contactHandles").withIndex("by_contact", (q) => q.eq("contactId", args.primaryContactId)).collect(),
      ctx.db.query("contactHandles").withIndex("by_contact", (q) => q.eq("contactId", args.secondaryContactId)).collect(),
    ]);

    // Detect field conflicts
    const conflicts: { field: string; primaryValue: string | undefined; secondaryValue: string | undefined }[] = [];
    if (primary.displayName !== secondary.displayName) {
      conflicts.push({ field: "displayName", primaryValue: primary.displayName, secondaryValue: secondary.displayName });
    }
    if (primary.company !== secondary.company && secondary.company) {
      conflicts.push({ field: "company", primaryValue: primary.company, secondaryValue: secondary.company });
    }
    if (primary.notes !== secondary.notes && secondary.notes) {
      conflicts.push({ field: "notes", primaryValue: primary.notes, secondaryValue: secondary.notes });
    }

    // Handle dedup: find which secondary handles already exist on primary
    const primaryHandleKeys = new Set(
      primaryHandles.map((h) =>
        buildContactHandleDedupKey(h.handleType, h.handle),
      ),
    );
    const handlesToMove = secondaryHandles.filter(
      (h) =>
        !primaryHandleKeys.has(buildContactHandleDedupKey(h.handleType, h.handle)),
    );
    const handlesToDedupe = secondaryHandles.filter((h) =>
      primaryHandleKeys.has(buildContactHandleDedupKey(h.handleType, h.handle)),
    );

    // Impact counts
    const conversations = await ctx.db.query("conversations").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const affectedConversations = conversations.filter((c) => c.participantContactIds.includes(args.secondaryContactId));

    const messages = await ctx.db.query("messages").withIndex("by_sender_contact", (q) => q.eq("senderContactId", args.secondaryContactId)).collect();

    const actions = await ctx.db.query("actions").withIndex("by_contact", (q) => q.eq("contactId", args.secondaryContactId)).collect();

    return {
      primary: { ...primary, handles: primaryHandles.map((h) => ({ type: h.handleType, value: h.handle, platform: h.platform })) },
      secondary: { ...secondary, handles: secondaryHandles.map((h) => ({ type: h.handleType, value: h.handle, platform: h.platform })) },
      conflicts,
      handlesToMove: handlesToMove.map((h) => ({ type: h.handleType, value: h.handle, platform: h.platform })),
      handlesToDedupe: handlesToDedupe.map((h) => ({ type: h.handleType, value: h.handle, platform: h.platform })),
      impact: {
        conversationsAffected: affectedConversations.length,
        messagesAffected: messages.length,
        actionsAffected: actions.length,
      },
    };
  },
});

// ============================================================================
// Contact Mutations
// ============================================================================

/**
 * Merge two contacts: move all handles from secondary to primary, delete secondary.
 * Updates all conversations and messages referencing the secondary contact.
 */
export const mergeContacts = mutation({
  args: {
    primaryContactId: v.id("contacts"),
    secondaryContactId: v.id("contacts"),
    suggestionId: v.optional(v.id("mergeSuggestions")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    if (args.primaryContactId === args.secondaryContactId) {
      throw new Error("Cannot merge a contact with itself");
    }

    const [primary, secondary] = await Promise.all([
      ctx.db.get(args.primaryContactId),
      ctx.db.get(args.secondaryContactId),
    ]);

    if (!primary || primary.userId !== user._id) {
      throw new Error("Primary contact not found");
    }
    if (!secondary || secondary.userId !== user._id) {
      throw new Error("Secondary contact not found");
    }

    if (args.suggestionId) {
      const suggestion = await ctx.db.get(args.suggestionId);
      if (!suggestion || suggestion.userId !== user._id) {
        throw new Error("Merge suggestion not found");
      }

      const matchesRequestedPair =
        (suggestion.contact1Id === args.primaryContactId &&
          suggestion.contact2Id === args.secondaryContactId) ||
        (suggestion.contact1Id === args.secondaryContactId &&
          suggestion.contact2Id === args.primaryContactId);
      if (!matchesRequestedPair) {
        throw new Error("Merge suggestion does not match selected contacts");
      }

      if (suggestion.status === "pending") {
        await ctx.db.patch(args.suggestionId, {
          status: "approved",
          resolvedAt: Date.now(),
        });
        await cleanupResolveContactAction(
          ctx,
          user,
          args.suggestionId,
          "completed",
        );
      }
    }

    const result = await executeContactMerge(ctx, {
      userId: user._id,
      primaryContact: primary,
      secondaryContact: secondary,
      primaryContactId: args.primaryContactId,
      secondaryContactId: args.secondaryContactId,
      actor: "user",
    });
    // Re-scan after manual/user merges so transitive duplicates are discovered.
    await scheduleContactMergeCheck(ctx, user._id, args.primaryContactId);

    return {
      success: true,
      handlesMovedCount: result.handlesMovedCount,
      conversationsUpdatedCount: result.conversationsUpdatedCount,
      messagesUpdatedCount: result.messagesUpdatedCount,
    };
  },
});

/**
 * Manual merge with field conflict resolution.
 * User picks which value wins for each conflicting field.
 */
export const manualMerge = mutation({
  args: {
    primaryContactId: v.id("contacts"),
    secondaryContactId: v.id("contacts"),
    fieldResolutions: v.optional(mergeFieldResolutionsValidator),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    if (args.primaryContactId === args.secondaryContactId) {
      throw new Error("Cannot merge a contact with itself");
    }

    const [primary, secondary] = await Promise.all([
      ctx.db.get(args.primaryContactId),
      ctx.db.get(args.secondaryContactId),
    ]);
    if (!primary || primary.userId !== user._id) throw new Error("Primary not found");
    if (!secondary || secondary.userId !== user._id) throw new Error("Secondary not found");

    const result = await executeContactMerge(ctx, {
      userId: user._id,
      primaryContact: primary,
      secondaryContact: secondary,
      primaryContactId: args.primaryContactId,
      secondaryContactId: args.secondaryContactId,
      actor: "user",
      fieldResolutions: args.fieldResolutions,
    });
    // Re-scan after manual/user merges so transitive duplicates are discovered.
    await scheduleContactMergeCheck(ctx, user._id, args.primaryContactId);

    return {
      success: true,
      handlesMovedCount: result.handlesMovedCount,
      conversationsUpdatedCount: result.conversationsUpdatedCount,
      messagesUpdatedCount: result.messagesUpdatedCount,
    };
  },
});

/**
 * Reject a merge suggestion - marks contacts as intentionally separate.
 */
export const rejectMerge = mutation({
  args: {
    suggestionId: v.id("mergeSuggestions"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion || suggestion.userId !== user._id) {
      throw new Error("Merge suggestion not found");
    }

    await ctx.db.patch(args.suggestionId, {
      status: "rejected",
      resolvedAt: Date.now(),
    });

    await cleanupResolveContactAction(
      ctx,
      user,
      args.suggestionId,
      "discarded",
    );

    // Insert keep-separate exclusion so this pair is never re-suggested
    await ensureContactExclusion(
      ctx,
      user._id,
      suggestion.contact1Id,
      suggestion.contact2Id,
    );

    return { success: true };
  },
});

/**
 * Create a merge suggestion (used by background job).
 */
export const createMergeSuggestion = mutation({
  args: {
    contact1Id: v.id("contacts"),
    contact2Id: v.id("contacts"),
    confidence: v.number(),
    source: mergeSourceValidator,
    reasoning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    if (args.contact1Id === args.contact2Id) {
      return { success: false, reason: "Cannot compare a contact with itself" };
    }

    // Verify both contacts belong to user
    const [contact1, contact2] = await Promise.all([
      ctx.db.get(args.contact1Id),
      ctx.db.get(args.contact2Id),
    ]);

    if (!contact1 || contact1.userId !== user._id) {
      throw new Error("Contact 1 not found");
    }
    if (!contact2 || contact2.userId !== user._id) {
      throw new Error("Contact 2 not found");
    }

    const [c1, c2] = normalizeContactPair(args.contact1Id, args.contact2Id);
    const exclusion = await ctx.db
      .query("contactExclusions")
      .withIndex("by_pair", (q) => q.eq("contact1Id", c1).eq("contact2Id", c2))
      .first();
    if (exclusion) {
      return { success: false, reason: "Contacts are marked keep-separate" };
    }

    // Check if suggestion already exists (in either direction)
    const existing = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_contacts", (q) =>
        q.eq("contact1Id", args.contact1Id).eq("contact2Id", args.contact2Id),
      )
      .unique();

    const existingReverse = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_contacts", (q) =>
        q.eq("contact1Id", args.contact2Id).eq("contact2Id", args.contact1Id),
      )
      .unique();

    if (existing || existingReverse) {
      return { success: false, reason: "Suggestion already exists" };
    }

    const suggestionId = await ctx.db.insert("mergeSuggestions", {
      userId: user._id,
      contact1Id: args.contact1Id,
      contact2Id: args.contact2Id,
      confidence: args.confidence,
      source: args.source,
      reasoning: args.reasoning,
      status: "pending",
      createdAt: Date.now(),
    });

    return { success: true, suggestionId };
  },
});

/**
 * Update contact details (name, company, notes, importance, tags).
 */
export const updateContact = mutation({
  args: {
    contactId: v.id("contacts"),
    displayName: v.optional(v.string()),
    company: v.optional(v.string()),
    notes: v.optional(v.string()),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const { contactId, ...fields } = args;

    // Filter out undefined values
    const updates = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    const displayNameChanged =
      typeof updates.displayName === "string" &&
      updates.displayName !== contact.displayName;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(contactId, updates);
      if (displayNameChanged) {
        await scheduleContactMergeCheck(ctx, user._id, contactId);
      }
    }

    return { success: true };
  },
});

/**
 * Add a handle to a contact and trigger event-driven merge detection.
 */
export const addContactHandle = mutation({
  args: {
    contactId: v.id("contacts"),
    handleType: handleTypeValidator,
    handle: v.string(),
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const normalizedHandle = normalizeHandleValue(
      args.handleType,
      args.handle,
    );
    if (!normalizedHandle) {
      throw new Error("Handle cannot be empty");
    }

    const existingHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();

    const duplicateOnContact = existingHandles.find(
      (h) =>
        h.handleType === args.handleType &&
        h.handle === normalizedHandle &&
        h.platform === args.platform,
    );

    if (duplicateOnContact) {
      return {
        success: true,
        created: false,
        handleId: duplicateOnContact._id,
      };
    }

    const handleId = await ctx.db.insert("contactHandles", {
      userId: user._id,
      contactId: args.contactId,
      handleType: args.handleType,
      handle: normalizedHandle,
      platform: args.platform,
    });

    await scheduleContactMergeCheck(ctx, user._id, args.contactId);

    return { success: true, created: true, handleId };
  },
});

/**
 * Update a handle's value/type/platform and trigger merge detection.
 */
export const updateContactHandle = mutation({
  args: {
    handleId: v.id("contactHandles"),
    handleType: v.optional(handleTypeValidator),
    handle: v.optional(v.string()),
    platform: v.optional(platformValidator),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const existingHandle = await ctx.db.get(args.handleId);
    if (!existingHandle || existingHandle.userId !== user._id) {
      throw new Error("Handle not found");
    }

    const nextType = args.handleType ?? existingHandle.handleType;
    const rawValue = args.handle ?? existingHandle.handle;
    const nextHandle = normalizeHandleValue(nextType, rawValue);
    const nextPlatform = args.platform ?? existingHandle.platform;

    if (!nextHandle) {
      throw new Error("Handle cannot be empty");
    }

    const changed =
      nextType !== existingHandle.handleType ||
      nextHandle !== existingHandle.handle ||
      nextPlatform !== existingHandle.platform;

    if (!changed) {
      return { success: true, changed: false };
    }

    const siblingHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) =>
        q.eq("contactId", existingHandle.contactId),
      )
      .collect();

    const duplicateSibling = siblingHandles.find(
      (h) =>
        h._id !== args.handleId &&
        h.handleType === nextType &&
        h.handle === nextHandle &&
        h.platform === nextPlatform,
    );

    if (duplicateSibling) {
      await ctx.db.delete(args.handleId);
    } else {
      await ctx.db.patch(args.handleId, {
        handleType: nextType,
        handle: nextHandle,
        platform: nextPlatform,
      });
    }

    await scheduleContactMergeCheck(ctx, user._id, existingHandle.contactId);

    return { success: true, changed: true };
  },
});

/**
 * Remove a handle and trigger merge detection for the affected contact.
 */
export const removeContactHandle = mutation({
  args: {
    handleId: v.id("contactHandles"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const handle = await ctx.db.get(args.handleId);
    if (!handle || handle.userId !== user._id) {
      throw new Error("Handle not found");
    }

    await ctx.db.delete(args.handleId);

    return { success: true };
  },
});

/**
 * Set contact status (active/archived).
 * Legacy dismissed inputs are treated as archived.
 * Discards pending actions when archiving.
 */
export const setContactStatus = mutation({
  args: {
    contactId: v.id("contacts"),
    status: contactStatusValidator,
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const targetStatus = args.status === "dismissed" ? "archived" : args.status;
    const oldStatus = getContactStatus(contact);
    if (oldStatus === targetStatus) return { success: true };

    const now = Date.now();

    // Store only active/archived status; clear legacy dismissed flag.
    await ctx.db.patch(args.contactId, {
      status: targetStatus,
      isDismissed: undefined,
    });

    // Discard pending actions when archiving.
    if (targetStatus !== "active") {
      const pendingByPrimary = await ctx.db
        .query("actions")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .filter((q) => q.eq(q.field("status"), "pending"))
        .collect();

      const pendingBySecondary = await ctx.db
        .query("actions")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "pending"),
        )
        .filter((q) => q.eq(q.field("secondaryContactId"), args.contactId))
        .collect();

      const seenActionIds = new Set(pendingByPrimary.map((action) => action._id));
      const pendingActions = [
        ...pendingByPrimary,
        ...pendingBySecondary.filter((action) => !seenActionIds.has(action._id)),
      ];

      for (const action of pendingActions) {
        await ctx.db.patch(action._id, { status: "discarded", discardedAt: now });
      }

      // Decrement pending action count
      const currentCount = user.pendingActionCount ?? 0;
      const newCount = Math.max(0, currentCount - pendingActions.length);
      if (newCount !== currentCount) {
        await ctx.db.patch(user._id, { pendingActionCount: newCount });
      }
    }

    // Write audit log
    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: args.contactId,
      action: "status_change",
      actor: "user",
      details: { oldStatus, newStatus: targetStatus },
      timestamp: now,
    });

    return { success: true };
  },
});

/**
 * Restore a contact to active status.
 */
export const restoreContact = mutation({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const oldStatus = getContactStatus(contact);
    if (oldStatus === "active") return { success: true };

    const now = Date.now();

    await ctx.db.patch(args.contactId, {
      status: "active",
      isDismissed: undefined,
    });

    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: args.contactId,
      action: "restore",
      actor: "user",
      details: { oldStatus },
      timestamp: now,
    });

    return { success: true };
  },
});

/**
 * Mark two contacts as intentionally separate (keep-separate).
 * Prevents future merge suggestions for this pair.
 */
export const keepSeparate = mutation({
  args: {
    contact1Id: v.id("contacts"),
    contact2Id: v.id("contacts"),
    suggestionId: v.optional(v.id("mergeSuggestions")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    if (args.contact1Id === args.contact2Id) {
      throw new Error("Cannot keep-separate a contact from itself");
    }

    const [contact1, contact2] = await Promise.all([
      ctx.db.get(args.contact1Id),
      ctx.db.get(args.contact2Id),
    ]);
    if (!contact1 || contact1.userId !== user._id) {
      throw new Error("Contact 1 not found");
    }
    if (!contact2 || contact2.userId !== user._id) {
      throw new Error("Contact 2 not found");
    }

    const [c1, c2] = normalizeContactPair(args.contact1Id, args.contact2Id);
    await ensureContactExclusion(ctx, user._id, c1, c2);

    // Reject the suggestion if provided
    if (args.suggestionId) {
      const suggestion = await ctx.db.get(args.suggestionId);
      if (!suggestion || suggestion.userId !== user._id) {
        throw new Error("Merge suggestion not found");
      }
      const [s1, s2] = normalizeContactPair(
        suggestion.contact1Id,
        suggestion.contact2Id,
      );
      if (s1 !== c1 || s2 !== c2) {
        throw new Error("Merge suggestion does not match selected contacts");
      }
      if (suggestion.status === "pending") {
        await ctx.db.patch(args.suggestionId, {
          status: "rejected",
          resolvedAt: Date.now(),
        });
        await cleanupResolveContactAction(ctx, user, args.suggestionId, "discarded");
      }
    }

    // Write audit logs for both contacts.
    const now = Date.now();
    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: c1,
      action: "keep_separate",
      actor: "user",
      details: { otherContactId: c2 },
      timestamp: now,
    });
    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: c2,
      action: "keep_separate",
      actor: "user",
      details: { otherContactId: c1 },
      timestamp: now,
    });

    return { success: true };
  },
});

/**
 * Get merge history entries that can be unmerged for a contact.
 */
export const getUnmergeableHistory = query({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return [];

    const [mergeEntries, unmergeEntries] = await Promise.all([
      ctx.db
        .query("contactAuditLog")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .filter((q) => q.eq(q.field("action"), "merge"))
        .order("desc")
        .collect(),
      ctx.db
        .query("contactAuditLog")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .filter((q) => q.eq(q.field("action"), "unmerge"))
        .collect(),
    ]);

    const revertedMergeIds = new Set(
      unmergeEntries.flatMap((e) =>
        e.userId === user._id && isUnmergeAuditDetails(e.details)
          ? [e.details.originalMergeAuditId]
          : [],
      ),
    );

    return mergeEntries.filter(
      (e) => e.userId === user._id && !revertedMergeIds.has(e._id),
    );
  },
});

/**
 * Get full audit history for a contact.
 */
export const getContactAuditHistory = query({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return [];

    const entries = await ctx.db
      .query("contactAuditLog")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .collect();

    return entries.filter((e) => e.userId === user._id);
  },
});

/**
 * Unmerge a previously merged contact by restoring from merge snapshot.
 * Recreates the secondary contact, moves handles and messages back.
 */
export const unmergeContact = mutation({
  args: {
    auditLogId: v.id("contactAuditLog"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const auditEntry = await ctx.db.get(args.auditLogId);
    if (!auditEntry || auditEntry.userId !== user._id || auditEntry.action !== "merge") {
      throw new Error("Merge audit entry not found");
    }

    if (!isMergeAuditDetails(auditEntry.details)) {
      throw new Error("Merge snapshot missing secondary contact data");
    }
    const details = auditEntry.details;

    const primaryContactId = auditEntry.contactId;
    const primary = await ctx.db.get(primaryContactId);
    if (!primary) throw new Error("Primary contact no longer exists");

    // Idempotency guard: return existing unmerge result if this merge was already reversed.
    const priorUnmerges = await ctx.db
      .query("contactAuditLog")
      .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
      .filter((q) => q.eq(q.field("action"), "unmerge"))
      .collect();
    const existingUnmerge = priorUnmerges.find(
      (entry) =>
        isUnmergeAuditDetails(entry.details) &&
        entry.details.originalMergeAuditId === args.auditLogId,
    );
    if (existingUnmerge && isUnmergeAuditDetails(existingUnmerge.details)) {
      return {
        success: true,
        restoredContactId: existingUnmerge.details.restoredContactId,
        handlesRestored: existingUnmerge.details.handlesRestored,
        messagesRestored: existingUnmerge.details.messagesRestored,
        alreadyUnmerged: true,
      };
    }

    const now = Date.now();

    // 1. Recreate secondary contact
    const secondaryContactId = await ctx.db.insert("contacts", {
      userId: user._id,
      displayName: details.secondaryContact.displayName,
      company: details.secondaryContact.company,
      notes: details.secondaryContact.notes,
      importance: details.secondaryContact.importance,
      tags: details.secondaryContact.tags,
      status: "active",
    });

    // 2. Move handles back (recreate deduped handles deleted during merge)
    let handlesRestored = 0;
    const restoredHandleIds = new Set<Id<"contactHandles">>();
    const dedupedHandlesById = new Map<Id<"contactHandles">, MergeDedupedHandleSnapshot>(
      (details.dedupedHandles ?? []).map((snapshot) => [snapshot.handleId, snapshot]),
    );
    const restoredDedupedHandleByMergedIntoId = new Map<
      Id<"contactHandles">,
      Id<"contactHandles">
    >();
    for (const handleId of details.handleIds) {
      const handle = await ctx.db.get(handleId);
      if (handle && handle.contactId === primaryContactId) {
        await ctx.db.patch(handle._id, { contactId: secondaryContactId });
        handlesRestored++;
        restoredHandleIds.add(handle._id);
        continue;
      }

      const dedupedHandleSnapshot = dedupedHandlesById.get(handleId);
      if (!dedupedHandleSnapshot) continue;

      const recreatedHandleId = await ctx.db.insert("contactHandles", {
        userId: user._id,
        contactId: secondaryContactId,
        handleType: dedupedHandleSnapshot.handleType,
        handle: dedupedHandleSnapshot.handle,
        platform: dedupedHandleSnapshot.platform,
      });
      handlesRestored++;
      restoredHandleIds.add(recreatedHandleId);
      restoredDedupedHandleByMergedIntoId.set(
        dedupedHandleSnapshot.mergedIntoHandleId,
        recreatedHandleId,
      );
    }

    // 3. Move messages back.
    // Older merge audits may include explicit messageIds. Newer audits avoid
    // large payloads and rely on senderHandleId precision at unmerge time.
    let messagesRestored = 0;
    const overflowMessageRefs = details.messageIds?.length
      ? []
      : await ctx.db
          .query("contactMergeMessageRefs")
          .withIndex("by_merge_audit", (q) => q.eq("mergeAuditId", args.auditLogId))
          .collect();
    const explicitMessageIds = details.messageIds?.length
      ? details.messageIds
      : [...new Set(overflowMessageRefs.map((ref) => ref.messageId))];

    if (explicitMessageIds.length > 0) {
      for (const msgId of explicitMessageIds) {
        const msg = await ctx.db.get(msgId);
        if (!msg || msg.senderContactId !== primaryContactId) continue;

        const updates: { senderContactId: Id<"contacts">; senderHandleId?: Id<"contactHandles"> } = {
          senderContactId: secondaryContactId,
        };
        if (msg.senderHandleId) {
          const restoredDedupedHandleId = restoredDedupedHandleByMergedIntoId.get(
            msg.senderHandleId,
          );
          if (restoredDedupedHandleId) {
            updates.senderHandleId = restoredDedupedHandleId;
          }
        }

        await ctx.db.patch(msg._id, updates);
        messagesRestored++;
      }
    } else {
      const messagesOnPrimary = await ctx.db
        .query("messages")
        .withIndex("by_sender_contact", (q) =>
          q.eq("senderContactId", primaryContactId),
        )
        .collect();
      for (const msg of messagesOnPrimary) {
        if (!msg.senderHandleId || !restoredHandleIds.has(msg.senderHandleId)) {
          continue;
        }

        await ctx.db.patch(msg._id, { senderContactId: secondaryContactId });
        messagesRestored++;
      }
    }

    // 4. Restore conversations based on merge snapshots.
    for (const snapshot of details.conversationSnapshots) {
      const conv = await ctx.db.get(snapshot.conversationId);
      if (!conv) continue;

      let updatedParticipants = conv.participantContactIds;
      if (!updatedParticipants.includes(secondaryContactId)) {
        updatedParticipants = [...updatedParticipants, secondaryContactId];
      }

      if (!snapshot.hadPrimaryBeforeMerge) {
        updatedParticipants = updatedParticipants.filter(
          (participantId) => participantId !== primaryContactId,
        );
      }

      const participantsChanged =
        updatedParticipants.length !== conv.participantContactIds.length ||
        updatedParticipants.some(
          (participantId, index) =>
            participantId !== conv.participantContactIds[index],
        );
      if (participantsChanged) {
        await ctx.db.patch(conv._id, {
          participantContactIds: updatedParticipants,
        });
      }
    }

    // 5. Restore primary fields that were changed by merge, but only if
    // they still match the merge-applied value (avoid clobbering later edits).
    const revertUpdates: Partial<
      Pick<Doc<"contacts">, "displayName" | "company" | "notes" | "importance" | "tags">
    > = {};
    const primaryFieldChanges = details.primaryFieldChanges;
    if (
      primaryFieldChanges?.displayName &&
      primary.displayName === primaryFieldChanges.displayName.after
    ) {
      revertUpdates.displayName = primaryFieldChanges.displayName.before;
    }
    if (
      primaryFieldChanges?.company &&
      primary.company === primaryFieldChanges.company.after
    ) {
      revertUpdates.company = primaryFieldChanges.company.before;
    }
    if (
      primaryFieldChanges?.notes &&
      primary.notes === primaryFieldChanges.notes.after
    ) {
      revertUpdates.notes = primaryFieldChanges.notes.before;
    }
    if (
      primaryFieldChanges?.importance &&
      primary.importance === primaryFieldChanges.importance.after
    ) {
      revertUpdates.importance = primaryFieldChanges.importance.before;
    }
    if (
      primaryFieldChanges?.tags &&
      areStringArraysEqual(primary.tags, primaryFieldChanges.tags.after)
    ) {
      revertUpdates.tags = primaryFieldChanges.tags.before;
    }
    if (Object.keys(revertUpdates).length > 0) {
      await ctx.db.patch(primaryContactId, revertUpdates);
    }

    // 6. Write unmerge audit
    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: primaryContactId,
      action: "unmerge",
      actor: "user",
      details: {
        restoredContactId: secondaryContactId,
        handlesRestored,
        messagesRestored,
        originalMergeAuditId: args.auditLogId,
      },
      timestamp: now,
    });

    // Treat unmerge as intentional separation so this pair is not re-suggested.
    await ensureContactExclusion(ctx, user._id, primaryContactId, secondaryContactId);

    // 7. Trigger merge re-evaluation for both contacts
    await scheduleContactMergeCheck(ctx, user._id, primaryContactId);
    await scheduleContactMergeCheck(ctx, user._id, secondaryContactId);

    return {
      success: true,
      restoredContactId: secondaryContactId,
      handlesRestored,
      messagesRestored,
    };
  },
});

/**
 * Detach a handle from its current contact.
 * If targetContactId provided: move handle to that contact.
 * Otherwise: create a new contact from the handle.
 * Repoints messages via senderHandleId for precision.
 */
export const detachHandle = mutation({
  args: {
    handleId: v.id("contactHandles"),
    targetContactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const handle = await ctx.db.get(args.handleId);
    if (!handle || handle.userId !== user._id) {
      throw new Error("Handle not found");
    }

    const sourceContactId = handle.contactId;
    const sourceContact = await ctx.db.get(sourceContactId);
    if (!sourceContact) throw new Error("Source contact not found");

    // Ensure source contact has more than one handle (can't detach the last one)
    const sourceHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", sourceContactId))
      .collect();

    if (sourceHandles.length <= 1) {
      throw new Error("Cannot detach the only handle on a contact");
    }

    const now = Date.now();
    let destinationContactId: Id<"contacts">;

    if (args.targetContactId) {
      // Move to existing contact
      const target = await ctx.db.get(args.targetContactId);
      if (!target || target.userId !== user._id) {
        throw new Error("Target contact not found");
      }
      destinationContactId = args.targetContactId;
    } else {
      // Create new contact from handle
      const displayName = handle.handle;
      destinationContactId = await ctx.db.insert("contacts", {
        userId: user._id,
        displayName,
        status: "active",
      });
    }

    // Move the handle
    await ctx.db.patch(args.handleId, { contactId: destinationContactId });

    // Repoint messages that were sent via this handle
    const messagesByHandle = await ctx.db
      .query("messages")
      .withIndex("by_sender_handle", (q) => q.eq("senderHandleId", args.handleId))
      .collect();

    for (const msg of messagesByHandle) {
      await ctx.db.patch(msg._id, { senderContactId: destinationContactId });
    }

    // Update conversations: add destination to participant lists where source was present
    // (for conversations that had messages from this handle)
    const affectedConvIds = new Set(messagesByHandle.map((m) => m.conversationId));
    for (const convId of affectedConvIds) {
      const conv = await ctx.db.get(convId);
      if (conv && !conv.participantContactIds.includes(destinationContactId)) {
        await ctx.db.patch(convId, {
          participantContactIds: [...conv.participantContactIds, destinationContactId],
        });
      }
    }

    // Write audit logs
    await ctx.db.insert("contactAuditLog", {
      userId: user._id,
      contactId: sourceContactId,
      action: "handle_detach",
      actor: "user",
      details: {
        handleId: args.handleId,
        handleValue: handle.handle,
        handleType: handle.handleType,
        destinationContactId,
        messagesRepointed: messagesByHandle.length,
      },
      timestamp: now,
    });

    if (args.targetContactId) {
      await ctx.db.insert("contactAuditLog", {
        userId: user._id,
        contactId: destinationContactId,
        action: "handle_move",
        actor: "user",
        details: {
          handleId: args.handleId,
          handleValue: handle.handle,
          handleType: handle.handleType,
          sourceContactId,
          messagesRepointed: messagesByHandle.length,
        },
        timestamp: now,
      });
    }

    // Trigger merge re-evaluation for both contacts
    await scheduleContactMergeCheck(ctx, user._id, sourceContactId);
    await scheduleContactMergeCheck(ctx, user._id, destinationContactId);

    return {
      success: true,
      destinationContactId,
      messagesRepointed: messagesByHandle.length,
      createdNewContact: !args.targetContactId,
    };
  },
});

// ============================================================================
// Internal Helpers
// ============================================================================

type MergeSource = ContactMergeSource;
type ContactAuditDetails = Doc<"contactAuditLog">["details"];

type MergeAuditDetails = {
  secondaryContact: {
    _id: Id<"contacts">;
    displayName: string;
    company?: string;
    notes?: string;
    importance?: number;
    tags?: string[];
  };
  handleIds: Id<"contactHandles">[];
  dedupedHandles?: MergeDedupedHandleSnapshot[];
  messageIds?: Id<"messages">[];
  conversationSnapshots: MergeConversationSnapshot[];
  actionIds?: Id<"actions">[];
  source?: MergeSource;
  reasoning?: string;
  fieldResolutions?: MergeFieldResolutions;
  primaryFieldChanges?: MergePrimaryFieldChanges;
};

type UnmergeAuditDetails = {
  restoredContactId: Id<"contacts">;
  handlesRestored: number;
  messagesRestored: number;
  originalMergeAuditId: Id<"contactAuditLog">;
};

function isMergeAuditDetails(details: ContactAuditDetails): details is MergeAuditDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as Partial<MergeAuditDetails>;
  const conversationSnapshotsValid =
    Array.isArray(candidate.conversationSnapshots) &&
    candidate.conversationSnapshots.every(
      (snapshot) =>
        !!snapshot &&
        typeof snapshot === "object" &&
        snapshot.conversationId !== undefined &&
        typeof snapshot.hadPrimaryBeforeMerge === "boolean",
    );
  const dedupedHandlesValid =
    candidate.dedupedHandles === undefined ||
    (Array.isArray(candidate.dedupedHandles) &&
      candidate.dedupedHandles.every(
        (snapshot) =>
          !!snapshot &&
          typeof snapshot === "object" &&
          snapshot.handleId !== undefined &&
          snapshot.mergedIntoHandleId !== undefined &&
          snapshot.handleType !== undefined &&
          typeof snapshot.handle === "string" &&
          snapshot.platform !== undefined,
      ));
  return (
    !!candidate.secondaryContact &&
    Array.isArray(candidate.handleIds) &&
    conversationSnapshotsValid &&
    dedupedHandlesValid
  );
}

function isUnmergeAuditDetails(
  details: ContactAuditDetails,
): details is UnmergeAuditDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as Partial<UnmergeAuditDetails>;
  return (
    candidate.restoredContactId !== undefined &&
    candidate.originalMergeAuditId !== undefined &&
    typeof candidate.handlesRestored === "number" &&
    typeof candidate.messagesRestored === "number"
  );
}

function areStringArraysEqual(
  left?: string[],
  right?: string[],
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function getContactWithHandles(ctx: QueryCtx, contactId: Id<"contacts">) {
  const contact = await ctx.db.get(contactId);
  if (!contact) return null;

  const handles = await ctx.db
    .query("contactHandles")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();

  return {
    ...contact,
    handles: handles.map((h) => ({
      type: h.handleType,
      value: h.handle,
      platform: h.platform,
    })),
  };
}

async function ensureContactExclusion(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact1Id: Id<"contacts">,
  contact2Id: Id<"contacts">,
): Promise<void> {
  const [c1, c2] = normalizeContactPair(contact1Id, contact2Id);
  const existingExclusion = await ctx.db
    .query("contactExclusions")
    .withIndex("by_pair", (q) => q.eq("contact1Id", c1).eq("contact2Id", c2))
    .first();
  if (existingExclusion) return;

  await ctx.db.insert("contactExclusions", {
    userId,
    contact1Id: c1,
    contact2Id: c2,
    createdAt: Date.now(),
  });
}

/**
 * Internal query to get a contact with handles (for use by internalActions).
 */
export const getContactWithHandlesInternal = internalQuery({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    return getContactWithHandles(ctx, args.contactId);
  },
});

/**
 * Clean up a resolve_contact action when its merge suggestion is resolved.
 * Marks the action as completed/discarded and decrements the pending count.
 */
async function cleanupResolveContactAction(
  ctx: MutationCtx,
  user: Doc<"users">,
  suggestionId: Id<"mergeSuggestions">,
  status: "completed" | "discarded",
): Promise<void> {
  const resolveAction = await ctx.db
    .query("actions")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .filter((q) =>
      q.and(
        q.eq(q.field("mergeSuggestionId"), suggestionId),
        q.eq(q.field("type"), "resolve_contact"),
      ),
    )
    .first();

  if (!resolveAction) return;

  const now = Date.now();
  if (status === "completed") {
    await ctx.db.patch(resolveAction._id, {
      status: "completed",
      completedAt: now,
    });
  } else {
    await ctx.db.patch(resolveAction._id, {
      status: "discarded",
      discardedAt: now,
    });
  }

  if (user.pendingActionCount && user.pendingActionCount > 0) {
    await ctx.db.patch(user._id, {
      pendingActionCount: user.pendingActionCount - 1,
    });
  }
}

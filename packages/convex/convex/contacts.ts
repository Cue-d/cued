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
} from "./schema";
import { scheduleContactMergeCheck } from "./lib/contactMergeScheduling";
import { normalizeHandleValue } from "./lib/normalizeHandle";
import {
  areContactAvatarOptionsEqual,
  buildPrimaryAvatarFields,
  getContactAvatarOptions,
  normalizePublicAvatarUrl,
  upsertContactAvatarOption,
} from "./lib/avatar";

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
    namedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { contacts: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 50, 100);

    // Fetch contacts - with search or regular query
    const isSearch = args.searchQuery && args.searchQuery.trim().length > 0;
    let rawContacts;

    if (isSearch) {
      rawContacts = await ctx.db
        .query("contacts")
        .withSearchIndex("search_display_name", (q) =>
          q.search("displayName", args.searchQuery!).eq("userId", user._id),
        )
        .take(limit + 1);
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

    // Filter out dismissed contacts for display, but compute pagination using
    // the raw window too so dismissed rows cannot terminate pagination early.
    const visibleContacts = rawContacts.filter((c) => !c.isDismissed);
    const results = visibleContacts.slice(0, limit);
    const hasExtraVisible = visibleContacts.length > limit;
    const hasExtraRaw = rawContacts.length > limit;
    const hasMore = hasExtraVisible || hasExtraRaw;

    // Cursor source:
    // - Prefer the last returned visible contact when we know another visible
    //   contact exists in this window (standard pagination).
    // - Otherwise use the raw window tail to advance past filtered rows.
    const cursorSource = hasMore
      ? (hasExtraVisible
        ? results[results.length - 1]
        : rawContacts[rawContacts.length - 1])
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
 * Returns contacts sorted alphabetically with handles, excluding dismissed.
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
      .filter((q) => q.neq(q.field("isDismissed"), true))
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

    // 1. Move all handles from secondary to primary
    const secondaryHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) =>
        q.eq("contactId", args.secondaryContactId),
      )
      .collect();

    for (const handle of secondaryHandles) {
      await ctx.db.patch(handle._id, { contactId: args.primaryContactId });
    }

    // 2. Update all conversations referencing secondary contact
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    for (const conv of conversations) {
      if (conv.participantContactIds.includes(args.secondaryContactId)) {
        // Remove secondary, add primary if not already present
        const withoutSecondary = conv.participantContactIds.filter(
          (id) => id !== args.secondaryContactId,
        );
        const hasPrimary = conv.participantContactIds.includes(
          args.primaryContactId,
        );
        const updatedParticipants = hasPrimary
          ? withoutSecondary
          : [...withoutSecondary, args.primaryContactId];

        await ctx.db.patch(conv._id, {
          participantContactIds: updatedParticipants,
        });
      }
    }

    // 3. Update all messages referencing secondary contact
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_sender_contact", (q) =>
        q.eq("senderContactId", args.secondaryContactId),
      )
      .collect();

    for (const msg of messages) {
      await ctx.db.patch(msg._id, { senderContactId: args.primaryContactId });
    }

    // 4. Update all actions referencing secondary contact
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_contact", (q) =>
        q.eq("contactId", args.secondaryContactId),
      )
      .collect();

    for (const action of actions) {
      await ctx.db.patch(action._id, { contactId: args.primaryContactId });
    }

    // 5. Merge contact metadata (prefer primary, fill gaps from secondary)
    const updates: Partial<Doc<"contacts">> = {};
    if (!primary.company && secondary.company) {
      updates.company = secondary.company;
    }
    if (!primary.notes && secondary.notes) {
      updates.notes = secondary.notes;
    }
    if (
      primary.importance === undefined &&
      secondary.importance !== undefined
    ) {
      updates.importance = secondary.importance;
    }

    // Preserve all avatar options from both contacts and keep highest-priority
    // source as the active avatar fields.
    const primaryAvatarOptions = getContactAvatarOptions(primary);
    const secondaryAvatarOptions = getContactAvatarOptions(secondary);
    let mergedAvatarOptions = primaryAvatarOptions;
    for (const option of secondaryAvatarOptions) {
      mergedAvatarOptions = upsertContactAvatarOption(mergedAvatarOptions, option);
    }
    if (!areContactAvatarOptionsEqual(primaryAvatarOptions, mergedAvatarOptions)) {
      Object.assign(updates, buildPrimaryAvatarFields(mergedAvatarOptions), {
        avatarOptions: mergedAvatarOptions,
      });
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.primaryContactId, updates);
    }

    // 6. Update merge suggestion and clean up action BEFORE deleting contact
    if (args.suggestionId) {
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

    // 7. Delete secondary contact (last step)
    await ctx.db.delete(args.secondaryContactId);

    return {
      success: true,
      handlesMovedCount: secondaryHandles.length,
      conversationsUpdatedCount: conversations.filter((c) =>
        c.participantContactIds.includes(args.secondaryContactId),
      ).length,
      messagesUpdatedCount: messages.length,
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
 * Save contact from action card (eod_contact or new_contact).
 * Updates contact details and marks the action as completed.
 */
export const saveContactFromCard = mutation({
  args: {
    actionId: v.id("actions"),
    contactId: v.id("contacts"),
    displayName: v.string(),
    company: v.optional(v.string()),
    notes: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    // If linking to existing contact, merge handles instead of updating
    linkToContactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const now = Date.now();

    // If linking to existing contact, merge handles and delete the new contact
    if (args.linkToContactId) {
      const existingContact = await ctx.db.get(args.linkToContactId);
      if (!existingContact || existingContact.userId !== user._id) {
        throw new Error("Target contact not found");
      }

      // Move all handles from new contact to existing contact
      const handles = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .collect();

      for (const handle of handles) {
        await ctx.db.patch(handle._id, { contactId: args.linkToContactId });
      }

      // Update existing contact with any new info (if provided and existing is empty)
      const updates: {
        company?: string;
        notes?: string;
        tags?: string[];
      } = {};

      if (args.company && !existingContact.company) {
        updates.company = args.company;
      }
      if (args.notes) {
        // Append notes if existing has notes
        updates.notes = existingContact.notes
          ? `${existingContact.notes}\n\n${args.notes}`
          : args.notes;
      }
      if (args.tags && args.tags.length > 0) {
        // Merge tags (deduplicate)
        const existingTags = existingContact.tags ?? [];
        updates.tags = [...new Set([...existingTags, ...args.tags])];
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(args.linkToContactId, updates);
      }

      // Update conversations to reference existing contact
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();

      for (const conv of conversations) {
        if (conv.participantContactIds.includes(args.contactId)) {
          const withoutNew = conv.participantContactIds.filter(
            (id) => id !== args.contactId,
          );
          const hasExisting = conv.participantContactIds.includes(
            args.linkToContactId,
          );
          const updated = hasExisting
            ? withoutNew
            : [...withoutNew, args.linkToContactId];
          await ctx.db.patch(conv._id, { participantContactIds: updated });
        }
      }

      // Update messages to reference existing contact
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_sender_contact", (q) =>
          q.eq("senderContactId", args.contactId),
        )
        .collect();

      for (const msg of messages) {
        await ctx.db.patch(msg._id, { senderContactId: args.linkToContactId });
      }

      // Delete the new contact (now merged)
      await ctx.db.delete(args.contactId);

      await scheduleContactMergeCheck(ctx, user._id, args.linkToContactId);
    } else {
      // Update the contact with form data
      await ctx.db.patch(args.contactId, {
        displayName: args.displayName,
        company: args.company,
        notes: args.notes,
        tags: args.tags,
      });

      if (args.displayName !== contact.displayName) {
        await scheduleContactMergeCheck(ctx, user._id, args.contactId);
      }
    }

    // Mark action as completed
    await ctx.db.patch(args.actionId, {
      status: "completed",
      completedAt: now,
    });

    // Decrement pending action count
    const currentCount = user.pendingActionCount ?? 0;
    if (currentCount > 0) {
      await ctx.db.patch(user._id, {
        pendingActionCount: currentCount - 1,
      });
    }

    return {
      success: true,
      merged: !!args.linkToContactId,
      contactId: args.linkToContactId ?? args.contactId,
    };
  },
});

/**
 * Dismiss a contact as spam/not-a-contact.
 * Marks the contact as dismissed and discards the action.
 */
export const dismissContact = mutation({
  args: {
    actionId: v.id("actions"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== user._id) {
      throw new Error("Action not found");
    }

    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.userId !== user._id) {
      throw new Error("Contact not found");
    }

    const now = Date.now();

    // Mark contact as dismissed (won't show in contact list, won't create future actions)
    await ctx.db.patch(args.contactId, {
      isDismissed: true,
    });

    // Mark action as discarded
    await ctx.db.patch(args.actionId, {
      status: "discarded",
      discardedAt: now,
    });

    // Decrement pending action count
    const currentCount = user.pendingActionCount ?? 0;
    if (currentCount > 0) {
      await ctx.db.patch(user._id, {
        pendingActionCount: currentCount - 1,
      });
    }

    return { success: true };
  },
});

// ============================================================================
// Internal Helpers
// ============================================================================

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

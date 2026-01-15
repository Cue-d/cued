import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUser } from "./lib/auth";
import { mergeSuggestionStatusValidator, mergeSourceValidator } from "./schema";

// ============================================================================
// Contact Queries
// ============================================================================

/**
 * Get all contacts for the current user with their handles.
 * Supports search by name and cursor-based pagination.
 */
export const getContacts = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.id("contacts")),
    searchQuery: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) return { contacts: [], nextCursor: null, totalCount: 0 };

    const limit = Math.min(args.limit ?? 50, 100);

    // Fetch contacts - with search or regular query
    let contacts: Array<{
      _id: Id<"contacts">;
      userId: Id<"users">;
      displayName: string;
      company?: string;
      notes?: string;
      importance?: number;
      tags?: string[];
      isDismissed?: boolean;
    }>;

    if (args.searchQuery && args.searchQuery.trim().length > 0) {
      // Use search index for text search
      const searchResults = await ctx.db
        .query("contacts")
        .withSearchIndex("search_display_name", (q) =>
          q.search("displayName", args.searchQuery!).eq("userId", user._id)
        )
        .take(limit + 1);
      // Filter out dismissed contacts
      contacts = searchResults.filter((c) => !c.isDismissed);
    } else {
      // Regular query with optional cursor
      let query = ctx.db
        .query("contacts")
        .withIndex("by_user", (q) => q.eq("userId", user._id));

      if (args.cursor) {
        query = query.filter((q) => q.gt(q.field("_id"), args.cursor!));
      }

      const results = await query.take(limit + 1);
      // Filter out dismissed contacts
      contacts = results.filter((c) => !c.isDismissed);
    }

    const hasMore = contacts.length > limit;
    const results = hasMore ? contacts.slice(0, -1) : contacts;

    // Fetch handles for each contact
    const contactsWithHandles = await Promise.all(
      results.map(async (contact) => {
        const handles = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect();

        return {
          ...contact,
          handles: handles.map((h) => ({
            type: h.handleType,
            value: h.handle,
            platform: h.platform,
          })),
        };
      })
    );

    // Get total count for display (excluding dismissed)
    const totalCount = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect()
      .then((all) => all.filter((c) => !c.isDismissed).length);

    return {
      contacts: contactsWithHandles,
      nextCursor: hasMore ? results[results.length - 1]._id : null,
      totalCount,
    };
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
      handles: handles.map((h) => ({
        type: h.handleType,
        value: h.handle,
        platform: h.platform,
      })),
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

    const limit = Math.min(args.limit ?? 20, 50);

    const suggestions = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .order("desc")
      .take(limit);

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
      })
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
        q.eq("userId", user._id).eq("status", "pending")
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
      .withIndex("by_contact", (q) => q.eq("contactId", args.secondaryContactId))
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
          (id) => id !== args.secondaryContactId
        );
        const hasPrimary = conv.participantContactIds.includes(args.primaryContactId);
        const updatedParticipants = hasPrimary
          ? withoutSecondary
          : [...withoutSecondary, args.primaryContactId];

        await ctx.db.patch(conv._id, { participantContactIds: updatedParticipants });
      }
    }

    // 3. Update all messages referencing secondary contact
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .filter((q) =>
        q.eq(q.field("senderContactId"), args.secondaryContactId)
      )
      .collect();

    for (const msg of messages) {
      await ctx.db.patch(msg._id, { senderContactId: args.primaryContactId });
    }

    // 4. Update all actions referencing secondary contact
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .filter((q) => q.eq(q.field("contactId"), args.secondaryContactId))
      .collect();

    for (const action of actions) {
      await ctx.db.patch(action._id, { contactId: args.primaryContactId });
    }

    // 5. Merge contact metadata (prefer primary, fill gaps from secondary)
    const updates: { company?: string; notes?: string; importance?: number } = {};
    if (!primary.company && secondary.company) {
      updates.company = secondary.company;
    }
    if (!primary.notes && secondary.notes) {
      updates.notes = secondary.notes;
    }
    if (primary.importance === undefined && secondary.importance !== undefined) {
      updates.importance = secondary.importance;
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.primaryContactId, updates);
    }

    // 6. Delete secondary contact
    await ctx.db.delete(args.secondaryContactId);

    // 7. Update merge suggestion if provided
    if (args.suggestionId) {
      await ctx.db.patch(args.suggestionId, {
        status: "approved",
        resolvedAt: Date.now(),
      });
    }

    return {
      success: true,
      handlesMovedCount: secondaryHandles.length,
      conversationsUpdatedCount: conversations.filter((c) =>
        c.participantContactIds.includes(args.secondaryContactId)
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
        q.eq("contact1Id", args.contact1Id).eq("contact2Id", args.contact2Id)
      )
      .unique();

    const existingReverse = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_contacts", (q) =>
        q.eq("contact1Id", args.contact2Id).eq("contact2Id", args.contact1Id)
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
      Object.entries(fields).filter(([_, v]) => v !== undefined)
    );

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(contactId, updates);
    }

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
            (id) => id !== args.contactId
          );
          const hasExisting = conv.participantContactIds.includes(args.linkToContactId);
          const updated = hasExisting
            ? withoutNew
            : [...withoutNew, args.linkToContactId];
          await ctx.db.patch(conv._id, { participantContactIds: updated });
        }
      }

      // Update messages to reference existing contact
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .filter((q) => q.eq(q.field("senderContactId"), args.contactId))
        .collect();

      for (const msg of messages) {
        await ctx.db.patch(msg._id, { senderContactId: args.linkToContactId });
      }

      // Delete the new contact (now merged)
      await ctx.db.delete(args.contactId);
    } else {
      // Update the contact with form data
      await ctx.db.patch(args.contactId, {
        displayName: args.displayName,
        company: args.company,
        notes: args.notes,
        tags: args.tags,
      });
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

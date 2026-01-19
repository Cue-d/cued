import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUser } from "./lib/auth";
import { normalizeEmail, emailsMatch, phonesMatch } from "@prm/ai";

type ContactWithHandles = Doc<"contacts"> & {
  handles: Array<{
    type: "phone" | "email" | "slack_id" | "linkedin_url" | "twitter_handle";
    value: string;
    platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter";
  }>;
};

/** Find merge candidates for a specific contact after sync. */
export const findMergeCandidatesForContact = internalAction({
  args: {
    userId: v.id("users"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    // Get the target contact with handles
    const targetContact = await ctx.runQuery(
      internal.contactResolution.getContactWithHandlesInternal,
      { contactId: args.contactId }
    );

    if (!targetContact) return { matches: [] };

    // Get all other contacts for comparison
    const allContacts = await ctx.runQuery(
      internal.contactResolution.getAllContactsWithHandlesInternal,
      { userId: args.userId, excludeContactId: args.contactId }
    );

    const matches: Array<{
      contactId: Id<"contacts">;
      confidence: number;
      source: "email_match" | "phone_match";
      reasoning: string;
    }> = [];

    for (const candidate of allContacts) {
      const match = findBestMatch(targetContact, candidate);
      if (match) {
        matches.push({
          contactId: candidate._id,
          confidence: match.confidence,
          source: match.source,
          reasoning: match.reasoning,
        });
      }
    }

    // Create merge suggestions for all matches (exact email/phone matches)
    for (const match of matches) {
      await ctx.runMutation(
        internal.contactResolution.createMergeSuggestionInternal,
        {
          userId: args.userId,
          contact1Id: match.contactId,
          contact2Id: args.contactId,
          confidence: match.confidence,
          source: match.source,
          reasoning: match.reasoning,
        }
      );
    }

    return { matches };
  },
});

/** Scan all contacts for merge candidates using handle-based indexing. */
export const scanAllContactsForMerges = internalAction({
  args: {
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    contactsScanned: number;
    comparisonsPerformed: number;
    suggestionsCreated: number;
  }> => {
    const duplicatePairs = await ctx.runQuery(
      internal.contactResolution.findDuplicateCandidatesInternal,
      { userId: args.userId }
    );

    let suggestionsCreated = 0;

    for (const pair of duplicatePairs) {
      await ctx.runMutation(
        internal.contactResolution.createMergeSuggestionInternal,
        {
          userId: args.userId,
          contact1Id: pair.contact1Id,
          contact2Id: pair.contact2Id,
          confidence: pair.confidence,
          source: pair.source,
          reasoning: `${(pair.confidence * 100).toFixed(0)}% match via ${pair.source}`,
        }
      );
      suggestionsCreated++;
    }

    return {
      contactsScanned: duplicatePairs.length * 2,
      comparisonsPerformed: duplicatePairs.length,
      suggestionsCreated,
    };
  },
});

/** Find duplicate candidates by indexing handles (O(n) instead of O(n²)). */
export const findDuplicateCandidatesInternal = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const handles = await ctx.db
      .query("contactHandles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const handleToContacts = new Map<string, Set<Id<"contacts">>>();

    for (const handle of handles) {
      const normalizedValue =
        handle.handleType === "email"
          ? normalizeEmail(handle.handle)
          : handle.handle.toLowerCase();

      if (!handleToContacts.has(normalizedValue)) {
        handleToContacts.set(normalizedValue, new Set());
      }
      handleToContacts.get(normalizedValue)!.add(handle.contactId);
    }

    // Index displayNames that look like email/phone as fallback
    for (const contact of contacts) {
      if (looksLikeEmail(contact.displayName)) {
        const normalized = normalizeEmail(contact.displayName);
        if (!handleToContacts.has(normalized)) {
          handleToContacts.set(normalized, new Set());
        }
        handleToContacts.get(normalized)!.add(contact._id);
      } else if (looksLikePhone(contact.displayName)) {
        const normalized = contact.displayName.replace(/[\s\-\(\)\.]/g, "");
        if (!handleToContacts.has(normalized)) {
          handleToContacts.set(normalized, new Set());
        }
        handleToContacts.get(normalized)!.add(contact._id);
      }
    }

    const duplicatePairs: Array<{
      contact1Id: Id<"contacts">;
      contact2Id: Id<"contacts">;
      confidence: number;
      source: "email_match" | "phone_match";
      sharedHandle: string;
    }> = [];

    const seenPairs = new Set<string>();

    for (const [handle, contactIds] of handleToContacts.entries()) {
      if (contactIds.size < 2) continue;

      const contactArray = Array.from(contactIds);
      const isEmail = handle.includes("@");

      for (let i = 0; i < contactArray.length; i++) {
        for (let j = i + 1; j < contactArray.length; j++) {
          const id1 = contactArray[i];
          const id2 = contactArray[j];
          const pairKey = [id1, id2].sort().join("-");

          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          duplicatePairs.push({
            contact1Id: id1,
            contact2Id: id2,
            confidence: 1.0,
            source: isEmail ? "email_match" : "phone_match",
            sharedHandle: handle,
          });
        }
      }
    }

    return duplicatePairs;
  },
});

/** Trigger a full scan for merge candidates (user-facing). */
export const triggerMergeScan = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    await ctx.scheduler.runAfter(
      0,
      internal.contactResolution.scanAllContactsForMerges,
      { userId: user._id }
    );

    return { success: true, message: "Merge scan scheduled" };
  },
});

export const getContactWithHandlesInternal = internalQuery({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args): Promise<ContactWithHandles | null> => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;

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

export const getAllContactsWithHandlesInternal = internalQuery({
  args: {
    userId: v.id("users"),
    excludeContactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args): Promise<ContactWithHandles[]> => {
    let contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (args.excludeContactId) {
      contacts = contacts.filter((c) => c._id !== args.excludeContactId);
    }

    const contactsWithHandles = await Promise.all(
      contacts.map(async (contact) => {
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

    return contactsWithHandles;
  },
});

export const createMergeSuggestionInternal = internalMutation({
  args: {
    userId: v.id("users"),
    contact1Id: v.id("contacts"),
    contact2Id: v.id("contacts"),
    confidence: v.number(),
    source: v.union(v.literal("email_match"), v.literal("phone_match")),
    reasoning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const [existing, existingReverse] = await Promise.all([
      ctx.db
        .query("mergeSuggestions")
        .withIndex("by_contacts", (q) =>
          q.eq("contact1Id", args.contact1Id).eq("contact2Id", args.contact2Id)
        )
        .unique(),
      ctx.db
        .query("mergeSuggestions")
        .withIndex("by_contacts", (q) =>
          q.eq("contact1Id", args.contact2Id).eq("contact2Id", args.contact1Id)
        )
        .unique(),
    ]);

    if (existing || existingReverse) {
      return { created: false, reason: "Already exists" };
    }

    const now = Date.now();

    const suggestionId = await ctx.db.insert("mergeSuggestions", {
      userId: args.userId,
      contact1Id: args.contact1Id,
      contact2Id: args.contact2Id,
      confidence: args.confidence,
      source: args.source,
      reasoning: args.reasoning,
      status: "pending",
      createdAt: now,
    });

    const priority = Math.round((1 - args.confidence) * 100);

    await ctx.db.insert("actions", {
      userId: args.userId,
      type: "resolve_contact",
      status: "pending",
      priority,
      contactId: args.contact1Id,
      secondaryContactId: args.contact2Id,
      mergeSuggestionId: suggestionId,
      reason: `${args.source}: ${(args.confidence * 100).toFixed(0)}% match`,
      llmReason: args.reasoning,
      createdAt: now,
    });

    const user = await ctx.db.get(args.userId);
    if (user) {
      await ctx.db.patch(args.userId, {
        pendingActionCount: (user.pendingActionCount ?? 0) + 1,
      });
    }

    return { created: true, suggestionId };
  },
});

export const autoMergeContacts = internalMutation({
  args: {
    primaryContactId: v.id("contacts"),
    secondaryContactId: v.id("contacts"),
    source: v.union(v.literal("email_match"), v.literal("phone_match")),
    reasoning: v.string(),
  },
  handler: async (ctx, args) => {
    const [primary, secondary] = await Promise.all([
      ctx.db.get(args.primaryContactId),
      ctx.db.get(args.secondaryContactId),
    ]);

    if (!primary || !secondary) {
      return { success: false, reason: "Contact not found" };
    }

    // Move handles from secondary to primary
    const secondaryHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) =>
        q.eq("contactId", args.secondaryContactId)
      )
      .collect();

    for (const handle of secondaryHandles) {
      await ctx.db.patch(handle._id, { contactId: args.primaryContactId });
    }

    // Update conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", primary.userId))
      .collect();

    for (const conv of conversations) {
      if (conv.participantContactIds.includes(args.secondaryContactId)) {
        const withoutSecondary = conv.participantContactIds.filter(
          (id) => id !== args.secondaryContactId
        );
        const hasPrimary = conv.participantContactIds.includes(
          args.primaryContactId
        );
        const updatedParticipants = hasPrimary
          ? withoutSecondary
          : [...withoutSecondary, args.primaryContactId];

        await ctx.db.patch(conv._id, {
          participantContactIds: updatedParticipants,
        });
      }
    }

    // Update messages
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", primary.userId))
      .filter((q) => q.eq(q.field("senderContactId"), args.secondaryContactId))
      .collect();

    for (const msg of messages) {
      await ctx.db.patch(msg._id, { senderContactId: args.primaryContactId });
    }

    // Merge contact metadata
    const updates: { company?: string; notes?: string; importance?: number } =
      {};
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
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.primaryContactId, updates);
    }

    await ctx.db.delete(args.secondaryContactId);

    // Log merge for audit trail
    await ctx.db.insert("mergeSuggestions", {
      userId: primary.userId,
      contact1Id: args.primaryContactId,
      contact2Id: args.secondaryContactId, // Will be invalid after delete, but kept for audit
      confidence: 1.0,
      source: args.source,
      reasoning: `Auto-merged: ${args.reasoning}`,
      status: "approved",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    });

    return { success: true, handlesMovedCount: secondaryHandles.length };
  },
});

type MatchResult = {
  confidence: number;
  source: "email_match" | "phone_match";
  reasoning: string;
};

function looksLikeEmail(value: string): boolean {
  return value.includes("@") && value.includes(".");
}

function looksLikePhone(value: string): boolean {
  const digitsOnly = value.replace(/[\s\-\(\)\+\.]/g, "");
  return (
    digitsOnly.length >= 7 && /^\d+$/.test(digitsOnly) && !value.includes("@")
  );
}

/** Extract handles of a specific type, including displayName as fallback. */
function getHandleValues(
  contact: ContactWithHandles,
  type: "email" | "phone"
): string[] {
  const handleValues = contact.handles
    .filter((h) => h.type === type)
    .map((h) => h.value);

  if (type === "email" && looksLikeEmail(contact.displayName)) {
    const normalized = contact.displayName.toLowerCase().trim();
    if (!handleValues.some((v) => v.toLowerCase() === normalized)) {
      handleValues.push(normalized);
    }
  }

  if (type === "phone" && looksLikePhone(contact.displayName)) {
    const normalized = contact.displayName.replace(/[\s\-\(\)\.]/g, "");
    if (!handleValues.includes(normalized)) {
      handleValues.push(normalized);
    }
  }

  return handleValues;
}

function findMatchingPair<T>(
  values1: T[],
  values2: T[],
  matcher: (a: T, b: T) => boolean
): [T, T] | null {
  for (const v1 of values1) {
    for (const v2 of values2) {
      if (matcher(v1, v2)) return [v1, v2];
    }
  }
  return null;
}

function findBestMatch(
  contact1: ContactWithHandles,
  contact2: ContactWithHandles
): MatchResult | null {
  const emailMatch = findMatchingPair(
    getHandleValues(contact1, "email"),
    getHandleValues(contact2, "email"),
    emailsMatch
  );
  if (emailMatch) {
    return {
      confidence: 1.0,
      source: "email_match",
      reasoning: `Matching email: ${normalizeEmail(emailMatch[0])}`,
    };
  }

  const phoneMatch = findMatchingPair(
    getHandleValues(contact1, "phone"),
    getHandleValues(contact2, "phone"),
    phonesMatch
  );
  if (phoneMatch) {
    return {
      confidence: 1.0,
      source: "phone_match",
      reasoning: `Matching phone: ${phoneMatch[0]}`,
    };
  }

  return null;
}


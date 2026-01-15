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
import {
  normalizeEmail,
  emailsMatch,
  phonesMatch,
  nameSimilarity,
  NAME_MATCH_THRESHOLDS,
} from "@prm/ai";

/**
 * Thresholds for merge decisions
 */
const MERGE_THRESHOLDS = {
  /** Auto-merge without user review */
  AUTO_MERGE: NAME_MATCH_THRESHOLDS.AUTO_MERGE, // 0.95
  /** Create suggestion for user review */
  SUGGEST_MERGE: NAME_MATCH_THRESHOLDS.SUGGEST_MERGE, // 0.80
  /** Minimum to consider at all */
  MINIMUM: NAME_MATCH_THRESHOLDS.MINIMUM, // 0.60
};

type ContactWithHandles = Doc<"contacts"> & {
  handles: Array<{
    type: "phone" | "email" | "slack_id" | "linkedin_url" | "twitter_handle";
    value: string;
    platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter";
  }>;
};

/**
 * Find merge candidates for a specific contact.
 * Called after a contact is synced to check for duplicates.
 */
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
      source: "email_match" | "phone_match" | "name_match";
      reasoning: string;
    }> = [];

    for (const candidate of allContacts) {
      const match = findBestMatch(targetContact, candidate);
      if (match && match.confidence >= MERGE_THRESHOLDS.MINIMUM) {
        matches.push({
          contactId: candidate._id,
          confidence: match.confidence,
          source: match.source,
          reasoning: match.reasoning,
        });
      }
    }

    // Process matches: auto-merge high confidence, suggest for medium
    for (const match of matches) {
      if (match.confidence >= MERGE_THRESHOLDS.AUTO_MERGE) {
        // Auto-merge (target becomes secondary, merge into existing)
        await ctx.runMutation(internal.contactResolution.autoMergeContacts, {
          primaryContactId: match.contactId,
          secondaryContactId: args.contactId,
          source: match.source,
          reasoning: match.reasoning,
        });
      } else if (match.confidence >= MERGE_THRESHOLDS.SUGGEST_MERGE) {
        // Create suggestion for user review
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
    }

    return { matches };
  },
});

/**
 * Scan all contacts for merge candidates.
 * Can be run periodically or triggered manually.
 */
export const scanAllContactsForMerges = internalAction({
  args: {
    userId: v.id("users"),
    maxComparisons: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    contactsScanned: number;
    comparisonsPerformed: number;
    suggestionsCreated: number;
    autoMerged: number;
  }> => {
    const maxComparisons = args.maxComparisons ?? 1000;

    const allContacts: ContactWithHandles[] = await ctx.runQuery(
      internal.contactResolution.getAllContactsWithHandlesInternal,
      { userId: args.userId }
    );

    const suggestions: Array<{
      contact1Id: Id<"contacts">;
      contact2Id: Id<"contacts">;
      confidence: number;
      source: "email_match" | "phone_match" | "name_match";
    }> = [];

    let comparisons = 0;

    // Compare each pair of contacts (O(n²) but limited by maxComparisons)
    for (
      let i = 0;
      i < allContacts.length && comparisons < maxComparisons;
      i++
    ) {
      for (
        let j = i + 1;
        j < allContacts.length && comparisons < maxComparisons;
        j++
      ) {
        comparisons++;
        const contact1 = allContacts[i];
        const contact2 = allContacts[j];

        const match = findBestMatch(contact1, contact2);
        if (match && match.confidence >= MERGE_THRESHOLDS.SUGGEST_MERGE) {
          suggestions.push({
            contact1Id: contact1._id,
            contact2Id: contact2._id,
            confidence: match.confidence,
            source: match.source,
          });
        }
      }
    }

    // Create suggestions for found matches
    for (const suggestion of suggestions) {
      if (suggestion.confidence >= MERGE_THRESHOLDS.AUTO_MERGE) {
        await ctx.runMutation(internal.contactResolution.autoMergeContacts, {
          primaryContactId: suggestion.contact1Id,
          secondaryContactId: suggestion.contact2Id,
          source: suggestion.source,
          reasoning: `Auto-merged with ${(suggestion.confidence * 100).toFixed(0)}% confidence via ${suggestion.source}`,
        });
      } else {
        await ctx.runMutation(
          internal.contactResolution.createMergeSuggestionInternal,
          {
            userId: args.userId,
            contact1Id: suggestion.contact1Id,
            contact2Id: suggestion.contact2Id,
            confidence: suggestion.confidence,
            source: suggestion.source,
            reasoning: `${(suggestion.confidence * 100).toFixed(0)}% match via ${suggestion.source}`,
          }
        );
      }
    }

    return {
      contactsScanned: allContacts.length,
      comparisonsPerformed: comparisons,
      suggestionsCreated: suggestions.filter(
        (s) => s.confidence < MERGE_THRESHOLDS.AUTO_MERGE
      ).length,
      autoMerged: suggestions.filter(
        (s) => s.confidence >= MERGE_THRESHOLDS.AUTO_MERGE
      ).length,
    };
  },
});

/**
 * Trigger a full scan for merge candidates (user-facing mutation).
 */
export const triggerMergeScan = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    // Schedule the scan as a background action
    await ctx.scheduler.runAfter(
      0,
      internal.contactResolution.scanAllContactsForMerges,
      {
        userId: user._id,
      }
    );

    return { success: true, message: "Merge scan scheduled" };
  },
});

// ============================================================================
// Internal Queries and Mutations
// ============================================================================

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
    source: v.union(
      v.literal("email_match"),
      v.literal("phone_match"),
      v.literal("name_match"),
      v.literal("llm_match")
    ),
    reasoning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
      return { created: false, reason: "Already exists" };
    }

    const now = Date.now();

    // Create the merge suggestion
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

    // Priority scales with confidence (higher confidence = lower urgency since easier decision)
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

    // Increment pending action count
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
    source: v.union(
      v.literal("email_match"),
      v.literal("phone_match"),
      v.literal("name_match"),
      v.literal("llm_match")
    ),
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

    // 1. Move all handles from secondary to primary
    const secondaryHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) =>
        q.eq("contactId", args.secondaryContactId)
      )
      .collect();

    for (const handle of secondaryHandles) {
      await ctx.db.patch(handle._id, { contactId: args.primaryContactId });
    }

    // 2. Update conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", primary.userId))
      .collect();

    for (const conv of conversations) {
      if (conv.participantContactIds.includes(args.secondaryContactId)) {
        // Remove secondary, add primary if not already present
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

    // 3. Update messages
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", primary.userId))
      .filter((q) => q.eq(q.field("senderContactId"), args.secondaryContactId))
      .collect();

    for (const msg of messages) {
      await ctx.db.patch(msg._id, { senderContactId: args.primaryContactId });
    }

    // 4. Merge contact metadata
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

    // 5. Delete secondary contact
    await ctx.db.delete(args.secondaryContactId);

    // 6. Log the auto-merge (create an approved suggestion for audit trail)
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

// ============================================================================
// Matching Logic (Pure Functions)
// ============================================================================

type MatchResult = {
  confidence: number;
  source: "email_match" | "phone_match" | "name_match";
  reasoning: string;
};

/** Check if a string looks like an email address */
function looksLikeEmail(value: string): boolean {
  return value.includes("@") && value.includes(".");
}

/** Check if a string looks like a phone number (digits with optional formatting) */
function looksLikePhone(value: string): boolean {
  // Remove common phone formatting characters
  const digitsOnly = value.replace(/[\s\-\(\)\+\.]/g, "");
  // Should be mostly digits (at least 7) and no @ symbol
  return (
    digitsOnly.length >= 7 && /^\d+$/.test(digitsOnly) && !value.includes("@")
  );
}

/** Extract handles of a specific type from a contact.
 * Also includes displayName if it looks like an email/phone (fallback for
 * placeholder contacts that might not have handles stored correctly).
 */
function getHandleValues(
  contact: ContactWithHandles,
  type: "email" | "phone"
): string[] {
  const handleValues = contact.handles
    .filter((h) => h.type === type)
    .map((h) => h.value);

  // For email matching, also include displayName if it looks like an email
  // This catches placeholder contacts where displayName IS the email
  if (type === "email" && looksLikeEmail(contact.displayName)) {
    const normalizedDisplayName = contact.displayName.toLowerCase().trim();
    if (!handleValues.some((v) => v.toLowerCase() === normalizedDisplayName)) {
      handleValues.push(normalizedDisplayName);
    }
  }

  // For phone matching, also include displayName if it looks like a phone
  if (type === "phone" && looksLikePhone(contact.displayName)) {
    const normalizedDisplayName = contact.displayName.replace(
      /[\s\-\(\)\.]/g,
      ""
    );
    if (!handleValues.includes(normalizedDisplayName)) {
      handleValues.push(normalizedDisplayName);
    }
  }

  return handleValues;
}

/** Check if any pair of values match using the provided matcher */
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
  // 1. Check for email match (highest priority - deterministic)
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

  // 2. Check for phone match (high priority - deterministic)
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

  // 3. Check for name match (fuzzy - lower priority)
  const nameScore = nameSimilarity(contact1.displayName, contact2.displayName);
  if (nameScore < MERGE_THRESHOLDS.MINIMUM) return null;

  let confidence = nameScore;
  let reasoning = `Name similarity: ${(nameScore * 100).toFixed(0)}%`;

  // Boost confidence if company also matches
  const companiesMatch =
    contact1.company &&
    contact2.company &&
    contact1.company.toLowerCase() === contact2.company.toLowerCase();

  if (companiesMatch) {
    confidence = Math.min(1.0, confidence + 0.1);
    reasoning += ` + matching company: ${contact1.company}`;
  }

  return { confidence, source: "name_match", reasoning };
}

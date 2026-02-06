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
  nameSimilarity,
  NAME_MATCH_THRESHOLDS,
  getPhoneVariants,
  phonesMatch,
  decideFuzzyMatchWithRetry,
  LLM_CONFIDENCE_THRESHOLD,
} from "@cued/ai";
import {
  normalizeMemberURN,
  extractIdFromURN,
  isLinkedInURN,
  normalizePhone,
  normalizeLinkedInHandle,
} from "@cued/shared";
import type { TypedHandle, MessageSnippet } from "@cued/ai";

const MAX_CONVERSATIONS_FOR_LLM_LOOKUP = 100;
const MAX_CONVERSATIONS_FOR_LLM_CONTEXT = 5;

/** Map handle type to TypedHandle type */
function toTypedHandleType(handleType: string): TypedHandle["type"] {
  switch (handleType) {
    case "email":
      return "email";
    case "phone":
      return "phone";
    case "linkedin_handle":
    case "linkedin_urn":
      return "linkedin";
    case "slack_id":
      return "slack";
    default:
      return "other";
  }
}

type DuplicatePair = {
  contact1Id: Id<"contacts">;
  contact2Id: Id<"contacts">;
  confidence: number;
  source:
    | "email_match"
    | "phone_match"
    | "exact_name_match"
    | "fuzzy_name_match"
    | "llm_fuzzy_match"
    | "linkedin_urn_match";
  sharedHandle?: string;
};

/** Get or create a Set in a Map. */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** Get contact data formatted for LLM match verification. */
export const getContactForLLMInternal = internalQuery({
  args: {
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;

    // Get handles
    const handles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();

    // Bound lookup to avoid unbounded per-pair reads during fuzzy scan.
    const recentConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_last_message", (q) => q.eq("userId", contact.userId))
      .order("desc")
      .take(MAX_CONVERSATIONS_FOR_LLM_LOOKUP);

    const conversations = recentConversations
      .filter((c) => c.participantContactIds.includes(args.contactId))
      .slice(0, MAX_CONVERSATIONS_FOR_LLM_CONTEXT);

    // Get recent messages from these conversations
    const recentMessages: MessageSnippet[] = [];
    for (const conv of conversations) {
      // Get messages FROM this contact (not random group chat msgs)
      const contactMsgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .filter((q) => q.eq(q.field("senderContactId"), args.contactId))
        .order("desc")
        .take(3);

      for (const msg of contactMsgs) {
        if (msg.content && recentMessages.length < 5) {
          recentMessages.push({
            text: msg.content.slice(0, 200),
            timestamp: new Date(msg.sentAt).toISOString(),
            platform: conv.platform,
            isFromContact: true,
            conversationType: conv.conversationType,
          });
        }
      }

      // Also get user's messages in this conversation (for context)
      const userMsgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .filter((q) => q.eq(q.field("isFromMe"), true))
        .order("desc")
        .take(2);

      for (const msg of userMsgs) {
        if (msg.content && recentMessages.length < 7) {
          recentMessages.push({
            text: msg.content.slice(0, 200),
            timestamp: new Date(msg.sentAt).toISOString(),
            platform: conv.platform,
            isFromContact: false,
            conversationType: conv.conversationType,
          });
        }
      }
    }

    // Format handles as TypedHandle[]
    const typedHandles: TypedHandle[] = handles.map((h) => ({
      type: toTypedHandleType(h.handleType),
      value: h.handle,
    }));

    return {
      displayName: contact.displayName,
      company: contact.company,
      handles: typedHandles,
      recentMessages,
      notes: contact.notes,
    };
  },
});

/** Scan all contacts for merge candidates using handle + name matching. */
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
    errors: string[];
  }> => {
    const result = await ctx.runQuery(
      internal.contactResolution.findDuplicateCandidatesInternal,
      { userId: args.userId }
    );

    let suggestionsCreated = 0;
    const errors: string[] = [];

    // Process all duplicate pairs (handle matches + name matches)
    for (const pair of result.duplicatePairs) {
      try {
        // LinkedIn URN matches are certain (same member ID) — auto-merge directly
        if (pair.source === "linkedin_urn_match") {
          await ctx.runMutation(
            internal.contactResolution.autoMergeContacts,
            {
              primaryContactId: pair.contact1Id,
              secondaryContactId: pair.contact2Id,
              source: pair.source,
              reasoning: `Same LinkedIn member ID`,
            }
          );
          continue;
        }

        const createResult = await ctx.runMutation(
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
        if (createResult.created) suggestionsCreated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[scanAllContactsForMerges] Failed to create suggestion: ` +
            `${pair.contact1Id} <-> ${pair.contact2Id} (${pair.source}): ${msg}`
        );
        errors.push(`${pair.source}: ${msg}`);
      }
    }

    // LLM verification for fuzzy matches
    for (const fuzzy of result.fuzzyPairs) {
      try {
        // Fetch contact data with handles and messages for LLM
        const [contact1Data, contact2Data] = await Promise.all([
          ctx.runQuery(internal.contactResolution.getContactForLLMInternal, {
            contactId: fuzzy.contact1Id,
          }),
          ctx.runQuery(internal.contactResolution.getContactForLLMInternal, {
            contactId: fuzzy.contact2Id,
          }),
        ]);

        if (!contact1Data || !contact2Data) {
          errors.push(`fuzzy_name_match: Contact not found`);
          continue;
        }

        // Call LLM for verification
        const llmResult = await decideFuzzyMatchWithRetry({
          contact1: contact1Data,
          contact2: contact2Data,
          fuzzyScore: fuzzy.confidence,
        });

        // Only create suggestion if LLM confirms same person with sufficient confidence
        if (
          !llmResult.samePerson ||
          llmResult.confidence < LLM_CONFIDENCE_THRESHOLD
        ) {
          console.log(
            `[scanAllContactsForMerges] LLM rejected fuzzy match: ` +
              `${contact1Data.displayName} <-> ${contact2Data.displayName} ` +
              `(samePerson=${llmResult.samePerson}, confidence=${llmResult.confidence})`
          );
          continue;
        }

        const createResult = await ctx.runMutation(
          internal.contactResolution.createMergeSuggestionInternal,
          {
            userId: args.userId,
            contact1Id: fuzzy.contact1Id,
            contact2Id: fuzzy.contact2Id,
            confidence: llmResult.confidence,
            source: "llm_fuzzy_match",
            reasoning: llmResult.reasoning,
          }
        );
        if (createResult.created) suggestionsCreated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[scanAllContactsForMerges] Failed to process fuzzy match: ` +
            `${fuzzy.contact1Id} <-> ${fuzzy.contact2Id}: ${msg}`
        );
        errors.push(`fuzzy_name_match: ${msg}`);
      }
    }

    // Batch update user's pending action count to avoid OCC conflicts
    if (suggestionsCreated > 0) {
      await ctx.runMutation(
        internal.contactResolution.incrementPendingActionCount,
        { userId: args.userId, count: suggestionsCreated }
      );
    }

    const totalComparisons =
      result.duplicatePairs.length + result.fuzzyPairs.length;

    return {
      contactsScanned: totalComparisons * 2,
      comparisonsPerformed: totalComparisons,
      suggestionsCreated,
      errors,
    };
  },
});

/**
 * Find duplicate candidates using INDEX-BASED matching for both handles and names.
 *
 * Both use the same O(n) approach:
 * 1. Build index: key → Set<contactIds>
 * 2. Only compare contacts that share a key
 *
 * Handle matching: key = normalized email/phone
 * Name matching: key = name token (each word in the name)
 */
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

    // Build handle index (email/phone → contactIds)
    // Only index valid emails (must contain @) and phones (must have 7+ digits)
    const handleToContacts = new Map<string, Set<Id<"contacts">>>();

    for (const handle of handles) {
      // Skip empty or whitespace-only handles
      const rawValue = handle.handle?.trim();
      if (!rawValue) continue;

      if (handle.handleType === "email") {
        // Only index valid-looking emails (must contain @)
        if (!rawValue.includes("@")) continue;
        const normalized = normalizeEmail(rawValue);
        if (normalized && normalized.includes("@")) {
          getOrCreateSet(handleToContacts, normalized).add(handle.contactId);
        }
      } else if (handle.handleType === "phone") {
        // Only index valid-looking phones (7+ digits)
        const digitsOnly = rawValue.replace(/\D/g, "");
        if (digitsOnly.length >= 7) {
          // Index ALL variants so different formats match (e.g., +15551234567 and 5551234567)
          const variants = getPhoneVariants(rawValue);
          for (const variant of variants) {
            getOrCreateSet(handleToContacts, variant).add(handle.contactId);
          }
        }
      } else if (handle.handleType === "linkedin_urn") {
        // Normalize URN and index by extracted member ID
        const normalized = normalizeMemberURN(rawValue).toLowerCase();
        const memberId = extractIdFromURN(normalized);
        if (memberId) {
          getOrCreateSet(handleToContacts, `linkedin_urn:${memberId}`).add(
            handle.contactId
          );
        }
      }
    }

    // Also index displayNames that look like email/phone (for contacts without proper handles)
    for (const contact of contacts) {
      const name = contact.displayName?.trim();
      if (!name) continue;

      if (looksLikeEmail(name)) {
        const normalized = normalizeEmail(name);
        // Double-check normalization result is valid
        if (normalized && normalized.includes("@")) {
          getOrCreateSet(handleToContacts, normalized).add(contact._id);
        }
      } else if (looksLikePhone(name)) {
        const digitsOnly = name.replace(/\D/g, "");
        if (digitsOnly.length >= 7) {
          // Index ALL variants so different formats match
          const variants = getPhoneVariants(name);
          for (const variant of variants) {
            getOrCreateSet(handleToContacts, variant).add(contact._id);
          }
        }
      }
    }

    // Build name token index (token → contactIds)
    // "John Doe" → tokens: ["john", "doe"]
    // Only compare contacts that share at least one token
    const nameTokenToContacts = new Map<string, Set<Id<"contacts">>>();
    const contactIdToContact = new Map<Id<"contacts">, (typeof contacts)[0]>();

    // Build contactId → handles map for conflict detection
    const contactIdToHandles = new Map<Id<"contacts">, typeof handles>();
    for (const handle of handles) {
      const existing = contactIdToHandles.get(handle.contactId) ?? [];
      existing.push(handle);
      contactIdToHandles.set(handle.contactId, existing);
    }

    for (const contact of contacts) {
      const name = contact.displayName;

      // Skip placeholder contacts (emails/phones/URNs as names) and dismissed
      if (
        contact.isDismissed ||
        !name.trim() ||
        looksLikeEmail(name) ||
        looksLikePhone(name) ||
        isLinkedInURN(name)
      ) {
        continue;
      }

      contactIdToContact.set(contact._id, contact);

      // Extract name tokens (lowercase words, min 2 chars to avoid initials)
      const tokens = name
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);

      for (const token of tokens) {
        getOrCreateSet(nameTokenToContacts, token).add(contact._id);
      }
    }

    // Find duplicates from handle index
    const duplicatePairs: DuplicatePair[] = [];
    const fuzzyPairs: DuplicatePair[] = [];
    const seenPairs = new Set<string>();
    const matchedByHandle = new Set<Id<"contacts">>();

    for (const [handle, contactIds] of handleToContacts.entries()) {
      if (contactIds.size < 2) continue;

      const contactArray = Array.from(contactIds);
      let source: DuplicatePair["source"];
      if (handle.startsWith("linkedin_urn:")) {
        source = "linkedin_urn_match";
      } else if (handle.includes("@")) {
        source = "email_match";
      } else {
        source = "phone_match";
      }

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
            source,
            sharedHandle: handle,
          });

          matchedByHandle.add(id1);
          matchedByHandle.add(id2);
        }
      }
    }

    // Helper: Check if two contacts have conflicting unique identifiers
    // Only considers phones and LinkedIn usernames as "unique" - emails are excluded since
    // people often have multiple emails (work/personal) for the same person
    // Uses phonesMatch for proper phone variant handling (+1 vs 10-digit)
    const hasConflictingHandles = (
      handles1: typeof handles | undefined,
      handles2: typeof handles | undefined
    ): boolean => {
      if (!handles1 || !handles2) return false;

      // Only check truly unique identifiers: phone, LinkedIn handle
      // Emails excluded - people often have work + personal emails
      const uniqueTypes = ["phone", "linkedin_handle", "linkedin_urn"];

      // Group handles by type
      const byType1 = new Map<string, string[]>();
      const byType2 = new Map<string, string[]>();

      for (const h of handles1) {
        if (!uniqueTypes.includes(h.handleType)) continue;
        const vals = byType1.get(h.handleType) ?? [];
        vals.push(h.handle);
        byType1.set(h.handleType, vals);
      }
      for (const h of handles2) {
        if (!uniqueTypes.includes(h.handleType)) continue;
        const vals = byType2.get(h.handleType) ?? [];
        vals.push(h.handle);
        byType2.set(h.handleType, vals);
      }

      // Check each handle type - if both have exactly 1 and they differ, conflict
      for (const [type, vals1] of byType1.entries()) {
        const vals2 = byType2.get(type);
        if (!vals2) continue;

        // Both have exactly 1 handle of this type
        if (vals1.length === 1 && vals2.length === 1) {
          const v1 = vals1[0];
          const v2 = vals2[0];

          if (type === "phone") {
            // Use phonesMatch which handles +1 variants
            if (!phonesMatch(v1, v2)) {
              return true; // Different phones = conflict
            }
          } else {
            // For LinkedIn handles, use lowercase comparison
            if (v1.toLowerCase() !== v2.toLowerCase()) {
              return true;
            }
          }
        }
      }

      return false;
    };

    // Find duplicates from name token index
    // Compare contacts that share a token - seenPairs prevents duplicate suggestions
    for (const [, contactIds] of nameTokenToContacts.entries()) {
      // Skip very common tokens that would cause too many comparisons
      if (contactIds.size < 2 || contactIds.size > 50) continue;

      const contactArray = Array.from(contactIds);

      for (let i = 0; i < contactArray.length; i++) {
        for (let j = i + 1; j < contactArray.length; j++) {
          const id1 = contactArray[i];
          const id2 = contactArray[j];
          const pairKey = [id1, id2].sort().join("-");

          if (seenPairs.has(pairKey)) continue;

          const c1 = contactIdToContact.get(id1);
          const c2 = contactIdToContact.get(id2);
          if (!c1 || !c2) continue;

          // Check for conflicting unique identifiers (different phone, email, linkedin, etc.)
          const handles1 = contactIdToHandles.get(id1);
          const handles2 = contactIdToHandles.get(id2);

          if (hasConflictingHandles(handles1, handles2)) {
            // Skip this pair - they have different unique identifiers
            seenPairs.add(pairKey);
            continue;
          }

          // Expensive Jaro-Winkler comparison
          const score = nameSimilarity(c1.displayName, c2.displayName);
          if (score < NAME_MATCH_THRESHOLDS.MINIMUM) continue;

          seenPairs.add(pairKey);
          const isExactMatch = score >= NAME_MATCH_THRESHOLDS.AUTO_MERGE;
          const targetArray = isExactMatch ? duplicatePairs : fuzzyPairs;

          targetArray.push({
            contact1Id: id1,
            contact2Id: id2,
            confidence: score,
            source: isExactMatch ? "exact_name_match" : "fuzzy_name_match",
          });
        }
      }
    }

    return { duplicatePairs, fuzzyPairs };
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

/**
 * Daily cron job to scan all users for merge candidates.
 * Schedules scanAllContactsForMerges for each user with connected integrations.
 */
export const dailyMergeScanAllUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all users with connected integrations
    const integrations = await ctx.db
      .query("integrations")
      .filter((q) => q.eq(q.field("isConnected"), true))
      .collect();

    // Get unique user IDs
    const userIds = [...new Set(integrations.map((i) => i.userId))];

    let scheduled = 0;
    for (const userId of userIds) {
      // Stagger scans to avoid overwhelming the system
      // Each scan starts 5 seconds after the previous
      await ctx.scheduler.runAfter(
        scheduled * 5000,
        internal.contactResolution.scanAllContactsForMerges,
        { userId }
      );
      scheduled++;
    }

    console.log(
      `[dailyMergeScanAllUsers] Scheduled merge scans for ${scheduled} users`
    );
    return { usersScheduled: scheduled };
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
      v.literal("exact_name_match"),
      v.literal("fuzzy_name_match"),
      v.literal("llm_fuzzy_match"),
      v.literal("linkedin_urn_match")
    ),
    reasoning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Normalize order: always put smaller ID first to ensure consistency
    const [c1, c2] =
      args.contact1Id < args.contact2Id
        ? [args.contact1Id, args.contact2Id]
        : [args.contact2Id, args.contact1Id];

    // Check for existing merge suggestion (only need to check one direction now)
    const existingSuggestion = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_contacts", (q) => q.eq("contact1Id", c1).eq("contact2Id", c2))
      .unique();

    if (existingSuggestion) {
      return { created: false, reason: "Suggestion already exists" };
    }

    // Also check for existing resolve_contact action for this pair
    const existingAction = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "pending")
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("type"), "resolve_contact"),
          q.eq(q.field("contactId"), c1),
          q.eq(q.field("secondaryContactId"), c2)
        )
      )
      .first();

    if (existingAction) {
      return { created: false, reason: "Action already exists" };
    }

    const now = Date.now();

    const suggestionId = await ctx.db.insert("mergeSuggestions", {
      userId: args.userId,
      contact1Id: c1,
      contact2Id: c2,
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
      contactId: c1,
      secondaryContactId: c2,
      mergeSuggestionId: suggestionId,
      // Denormalized merge data for UI rendering
      mergeConfidence: args.confidence,
      mergeSource: args.source,
      mergeReasoning: args.reasoning,
      reason: `${args.source}: ${(args.confidence * 100).toFixed(0)}% match`,
      llmReason: args.reasoning,
      createdAt: now,
    });

    // Note: pendingActionCount is updated by the caller in batch to avoid OCC conflicts
    return { created: true, suggestionId };
  },
});

/** Increment user's pending action count by a given amount (batched to avoid OCC). */
export const incrementPendingActionCount = internalMutation({
  args: {
    userId: v.id("users"),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.count <= 0) return;
    const user = await ctx.db.get(args.userId);
    if (!user) {
      console.error(
        `[incrementPendingActionCount] User not found: ${args.userId}. ` +
          `Failed to increment pendingActionCount by ${args.count}.`
      );
      return;
    }
    await ctx.db.patch(args.userId, {
      pendingActionCount: (user.pendingActionCount ?? 0) + args.count,
    });
  },
});

export const autoMergeContacts = internalMutation({
  args: {
    primaryContactId: v.id("contacts"),
    secondaryContactId: v.id("contacts"),
    source: v.union(
      v.literal("email_match"),
      v.literal("phone_match"),
      v.literal("exact_name_match"),
      v.literal("fuzzy_name_match"),
      v.literal("llm_fuzzy_match"),
      v.literal("linkedin_urn_match")
    ),
    reasoning: v.string(),
  },
  handler: async (ctx, args) => {
    const [contactA, contactB] = await Promise.all([
      ctx.db.get(args.primaryContactId),
      ctx.db.get(args.secondaryContactId),
    ]);

    if (!contactA || !contactB) {
      return { success: false, reason: "Contact not found" };
    }

    // Fetch handles for both contacts before choosing primary, so we can
    // choose the higher-quality record and dedupe with canonical keys.
    const [handlesA, handlesB] = await Promise.all([
      ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) =>
          q.eq("contactId", args.primaryContactId)
        )
        .collect(),
      ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) =>
          q.eq("contactId", args.secondaryContactId)
        )
        .collect(),
    ]);

    const preferredIsA =
      getContactQualityScore(contactA, handlesA) >=
      getContactQualityScore(contactB, handlesB);

    const primaryContactId = preferredIsA
      ? args.primaryContactId
      : args.secondaryContactId;
    const secondaryContactId = preferredIsA
      ? args.secondaryContactId
      : args.primaryContactId;
    const primary = preferredIsA ? contactA : contactB;
    const secondary = preferredIsA ? contactB : contactA;
    const primaryHandles = preferredIsA ? handlesA : handlesB;
    const secondaryHandles = preferredIsA ? handlesB : handlesA;

    const existingHandleKeys = new Set(
      primaryHandles.map((h) => buildHandleDedupKey(h.handleType, h.handle))
    );

    for (const handle of secondaryHandles) {
      const key = buildHandleDedupKey(handle.handleType, handle.handle);
      if (existingHandleKeys.has(key)) {
        // Primary already has this handle — delete the duplicate
        await ctx.db.delete(handle._id);
      } else {
        await ctx.db.patch(handle._id, { contactId: primaryContactId });
        existingHandleKeys.add(key);
      }
    }

    // Update conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", primary.userId))
      .collect();

    for (const conv of conversations) {
      if (conv.participantContactIds.includes(secondaryContactId)) {
        const withoutSecondary = conv.participantContactIds.filter(
          (id) => id !== secondaryContactId
        );
        const hasPrimary = conv.participantContactIds.includes(primaryContactId);
        const updatedParticipants = hasPrimary
          ? withoutSecondary
          : [...withoutSecondary, primaryContactId];

        await ctx.db.patch(conv._id, {
          participantContactIds: updatedParticipants,
        });
      }
    }

    // Update messages (use by_sender_contact index for efficiency)
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_sender_contact", (q) =>
        q.eq("senderContactId", secondaryContactId)
      )
      .collect();

    for (const msg of messages) {
      await ctx.db.patch(msg._id, { senderContactId: primaryContactId });
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
      await ctx.db.patch(primaryContactId, updates);
    }

    await ctx.db.delete(secondaryContactId);

    // Log merge for audit trail
    await ctx.db.insert("mergeSuggestions", {
      userId: primary.userId,
      contact1Id: primaryContactId,
      contact2Id: secondaryContactId, // Will be invalid after delete, but kept for audit
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

function normalizeHandleForDedup(handleType: string, handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";

  switch (handleType) {
    case "email":
      return normalizeEmail(trimmed) || trimmed.toLowerCase();
    case "phone":
      return normalizePhone(trimmed);
    case "linkedin_urn":
      return normalizeMemberURN(trimmed).toLowerCase();
    case "linkedin_handle":
      return normalizeLinkedInHandle(trimmed) || trimmed.toLowerCase();
    case "twitter_handle":
      return trimmed.toLowerCase().replace(/^@/, "");
    default:
      return trimmed;
  }
}

function buildHandleDedupKey(handleType: string, handle: string): string {
  const normalized = normalizeHandleForDedup(handleType, handle);
  return `${handleType}:${normalized || handle.trim()}`;
}

function isPlaceholderDisplayName(value: string): boolean {
  const name = value.trim();
  return (
    !name ||
    looksLikeEmail(name) ||
    looksLikePhone(name) ||
    isLinkedInURN(name) ||
    /^U[A-Z0-9]+$/i.test(name) ||
    /^linkedin user$/i.test(name)
  );
}

function getContactQualityScore(
  contact: Doc<"contacts">,
  handles: Doc<"contactHandles">[]
): number {
  let score = 0;
  if (!isPlaceholderDisplayName(contact.displayName)) score += 100;
  if (contact.displayName.trim().split(/\s+/).filter(Boolean).length >= 2) {
    score += 10;
  }
  if (contact.company) score += 8;
  if (contact.notes) score += 8;
  if (contact.importance !== undefined) score += 4;

  const uniqueHandleCount = new Set(
    handles.map((h) => buildHandleDedupKey(h.handleType, h.handle))
  ).size;
  score += Math.min(10, uniqueHandleCount);

  return score;
}

function looksLikeEmail(value: string): boolean {
  return value.includes("@") && value.includes(".");
}

function looksLikePhone(value: string): boolean {
  const digitsOnly = value.replace(/[\s\-\(\)\+\.]/g, "");
  return (
    digitsOnly.length >= 7 && /^\d+$/.test(digitsOnly) && !value.includes("@")
  );
}

/** Clear pending resolve_contact actions and merge suggestions in batches (for cleanup after bug fixes). */
export const clearPendingMergeSuggestions = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    const BATCH_SIZE = 500; // Stay well under the 4096 read limit

    // Delete batch of pending merge suggestions
    const pendingSuggestions = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .take(BATCH_SIZE);

    for (const suggestion of pendingSuggestions) {
      await ctx.db.delete(suggestion._id);
    }

    // Delete batch of pending resolve_contact actions
    const pendingActions = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending")
      )
      .filter((q) => q.eq(q.field("type"), "resolve_contact"))
      .take(BATCH_SIZE);

    for (const action of pendingActions) {
      await ctx.db.delete(action._id);
    }

    // Update user's pending action count
    if (pendingActions.length > 0) {
      await ctx.db.patch(user._id, {
        pendingActionCount: Math.max(
          0,
          (user.pendingActionCount ?? 0) - pendingActions.length
        ),
      });
    }

    // Check if there's more to delete
    const hasMore =
      pendingSuggestions.length === BATCH_SIZE ||
      pendingActions.length === BATCH_SIZE;

    return {
      suggestionsCleared: pendingSuggestions.length,
      actionsCleared: pendingActions.length,
      hasMore, // UI should call again if true
    };
  },
});

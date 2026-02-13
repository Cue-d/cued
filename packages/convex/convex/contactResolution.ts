import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
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
} from "@cued/shared";
import type { TypedHandle, MessageSnippet } from "@cued/ai";
import { scheduleContactMergeCheck } from "./lib/contactMergeScheduling";
import { normalizeHandleValue } from "./lib/normalizeHandle";

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

type DuplicateCandidateResult = {
  duplicatePairs: DuplicatePair[];
  fuzzyPairs: DuplicatePair[];
};

const MAX_NAME_TOKEN_BUCKET_SIZE = 50;

/** Get or create a Set in a Map. */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function getPairKey(
  contact1Id: Id<"contacts">,
  contact2Id: Id<"contacts">,
): string {
  return [contact1Id, contact2Id].sort().join("-");
}

function getNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function shouldIncludeContactInNameMatching(
  contact: Doc<"contacts">,
  handles: Doc<"contactHandles">[] | undefined,
): boolean {
  const name = contact.displayName;
  return (
    !contact.isDismissed &&
    !!name.trim() &&
    !looksLikeEmail(name) &&
    !looksLikePhone(name) &&
    !isLinkedInURN(name) &&
    (handles?.some((handle) => !!handle.handle?.trim()) ?? false)
  );
}

function buildContactHandlesByContactId(
  handles: Doc<"contactHandles">[],
): Map<Id<"contacts">, Doc<"contactHandles">[]> {
  const contactIdToHandles = new Map<Id<"contacts">, Doc<"contactHandles">[]>();
  for (const handle of handles) {
    const existing = contactIdToHandles.get(handle.contactId) ?? [];
    existing.push(handle);
    contactIdToHandles.set(handle.contactId, existing);
  }
  return contactIdToHandles;
}

function buildHandleToContactsIndex(
  contacts: Doc<"contacts">[],
  handles: Doc<"contactHandles">[],
): Map<string, Set<Id<"contacts">>> {
  const handleToContacts = new Map<string, Set<Id<"contacts">>>();

  for (const handle of handles) {
    const rawValue = handle.handle?.trim();
    if (!rawValue) continue;

    if (handle.handleType === "email") {
      if (!rawValue.includes("@")) continue;
      const normalized = normalizeEmail(rawValue);
      if (normalized && normalized.includes("@")) {
        getOrCreateSet(handleToContacts, normalized).add(handle.contactId);
      }
    } else if (handle.handleType === "phone") {
      const digitsOnly = rawValue.replace(/\D/g, "");
      if (digitsOnly.length >= 7) {
        const variants = getPhoneVariants(rawValue);
        for (const variant of variants) {
          getOrCreateSet(handleToContacts, variant).add(handle.contactId);
        }
      }
    } else if (handle.handleType === "linkedin_urn") {
      const normalized = normalizeMemberURN(rawValue).toLowerCase();
      const memberId = extractIdFromURN(normalized);
      if (memberId) {
        getOrCreateSet(handleToContacts, `linkedin_urn:${memberId}`).add(
          handle.contactId,
        );
      }
    }
  }

  for (const contact of contacts) {
    const name = contact.displayName?.trim();
    if (!name) continue;

    if (looksLikeEmail(name)) {
      const normalized = normalizeEmail(name);
      if (normalized && normalized.includes("@")) {
        getOrCreateSet(handleToContacts, normalized).add(contact._id);
      }
    } else if (looksLikePhone(name)) {
      const digitsOnly = name.replace(/\D/g, "");
      if (digitsOnly.length >= 7) {
        const variants = getPhoneVariants(name);
        for (const variant of variants) {
          getOrCreateSet(handleToContacts, variant).add(contact._id);
        }
      }
    }
  }

  return handleToContacts;
}

function buildNameTokenToContactsIndex(
  contacts: Doc<"contacts">[],
  contactIdToHandles: Map<Id<"contacts">, Doc<"contactHandles">[]>,
): Map<string, Set<Id<"contacts">>> {
  const nameTokenToContacts = new Map<string, Set<Id<"contacts">>>();

  for (const contact of contacts) {
    const handles = contactIdToHandles.get(contact._id);
    if (!shouldIncludeContactInNameMatching(contact, handles)) continue;

    for (const token of getNameTokens(contact.displayName)) {
      getOrCreateSet(nameTokenToContacts, token).add(contact._id);
    }
  }

  return nameTokenToContacts;
}

function hasConflictingHandles(
  handles1: Doc<"contactHandles">[] | undefined,
  handles2: Doc<"contactHandles">[] | undefined,
): boolean {
  if (!handles1 || !handles2) return false;

  const uniqueTypes = ["phone", "linkedin_handle", "linkedin_urn", "slack_id", "twitter_handle"];
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

  for (const [type, vals1] of byType1.entries()) {
    const vals2 = byType2.get(type);
    if (!vals2) continue;

    if (vals1.length === 1 && vals2.length === 1) {
      const v1 = vals1[0];
      const v2 = vals2[0];

      if (type === "phone") {
        if (!phonesMatch(v1, v2)) {
          return true;
        }
      } else if (v1.toLowerCase() !== v2.toLowerCase()) {
        return true;
      }
    }
  }

  return false;
}

function getDuplicateSourceForHandle(
  handleKey: string,
): DuplicatePair["source"] {
  if (handleKey.startsWith("linkedin_urn:")) {
    return "linkedin_urn_match";
  }
  if (handleKey.includes("@")) {
    return "email_match";
  }
  return "phone_match";
}

function isDeterministicHandleSource(source: DuplicatePair["source"]): boolean {
  return (
    source === "email_match" ||
    source === "phone_match" ||
    source === "linkedin_urn_match"
  );
}

function getAutoMergeReason(pair: DuplicatePair): string {
  if (pair.source === "linkedin_urn_match") {
    return "Same LinkedIn member ID";
  }
  if (pair.source === "email_match") {
    return pair.sharedHandle
      ? `Matching email ${pair.sharedHandle}`
      : "Matching email";
  }
  if (pair.source === "phone_match") {
    return pair.sharedHandle
      ? `Matching phone ${pair.sharedHandle}`
      : "Matching phone";
  }
  return `Deterministic match via ${pair.source}`;
}

/** Accumulated state while processing duplicate/fuzzy candidate pairs. */
type MergeProcessingResult = {
  suggestionsCreated: number;
  errors: string[];
};

/**
 * Process deterministic and name-match duplicate pairs -- auto-merging when
 * the source is a handle match, otherwise creating a suggestion.
 */
async function processDuplicatePairs(
  ctx: ActionCtx,
  userId: Id<"users">,
  pairs: DuplicatePair[],
  callerLabel: string,
  out: MergeProcessingResult,
): Promise<void> {
  for (const pair of pairs) {
    try {
      if (isDeterministicHandleSource(pair.source)) {
        const mergeResult = await ctx.runMutation(
          internal.contactResolution.autoMergeContacts,
          {
            primaryContactId: pair.contact1Id,
            secondaryContactId: pair.contact2Id,
            source: pair.source,
            reasoning: getAutoMergeReason(pair),
          },
        );
        if (!mergeResult.success) {
          out.errors.push(
            `${pair.source}: ${mergeResult.reason ?? "Auto-merge failed"}`,
          );
        }
        continue;
      }

      const createResult = await ctx.runMutation(
        internal.contactResolution.createMergeSuggestionInternal,
        {
          userId,
          contact1Id: pair.contact1Id,
          contact2Id: pair.contact2Id,
          confidence: pair.confidence,
          source: pair.source,
          reasoning: `${(pair.confidence * 100).toFixed(0)}% match via ${pair.source}`,
        },
      );
      if (createResult.created) out.suggestionsCreated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[${callerLabel}] Failed to process pair: ` +
          `${pair.contact1Id} <-> ${pair.contact2Id} (${pair.source}): ${msg}`,
      );
      out.errors.push(`${pair.source}: ${msg}`);
    }
  }
}

/**
 * Process fuzzy name-match pairs -- verifies each via LLM before creating
 * a merge suggestion.
 */
async function processFuzzyPairs(
  ctx: ActionCtx,
  userId: Id<"users">,
  pairs: DuplicatePair[],
  callerLabel: string,
  out: MergeProcessingResult,
): Promise<void> {
  for (const fuzzy of pairs) {
    try {
      const [contact1Data, contact2Data] = await Promise.all([
        ctx.runQuery(internal.contactResolution.getContactForLLMInternal, {
          contactId: fuzzy.contact1Id,
        }),
        ctx.runQuery(internal.contactResolution.getContactForLLMInternal, {
          contactId: fuzzy.contact2Id,
        }),
      ]);

      if (!contact1Data || !contact2Data) {
        out.errors.push("fuzzy_name_match: Contact not found");
        continue;
      }

      const llmResult = await decideFuzzyMatchWithRetry({
        contact1: contact1Data,
        contact2: contact2Data,
        fuzzyScore: fuzzy.confidence,
      });

      if (
        !llmResult.samePerson ||
        llmResult.confidence < LLM_CONFIDENCE_THRESHOLD
      ) {
        console.log(
          `[${callerLabel}] LLM rejected fuzzy match: ` +
            `${contact1Data.displayName} <-> ${contact2Data.displayName} ` +
            `(samePerson=${llmResult.samePerson}, confidence=${llmResult.confidence})`,
        );
        continue;
      }

      const createResult = await ctx.runMutation(
        internal.contactResolution.createMergeSuggestionInternal,
        {
          userId,
          contact1Id: fuzzy.contact1Id,
          contact2Id: fuzzy.contact2Id,
          confidence: llmResult.confidence,
          source: "llm_fuzzy_match",
          reasoning: llmResult.reasoning,
        },
      );
      if (createResult.created) out.suggestionsCreated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[${callerLabel}] Failed to process fuzzy match: ` +
          `${fuzzy.contact1Id} <-> ${fuzzy.contact2Id}: ${msg}`,
      );
      out.errors.push(`fuzzy_name_match: ${msg}`);
    }
  }
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

/** Process candidates and record suggestions, returning merge stats. */
async function processAndRecordCandidates(
  ctx: ActionCtx,
  userId: Id<"users">,
  candidates: DuplicateCandidateResult,
  label: string,
): Promise<MergeProcessingResult> {
  const out: MergeProcessingResult = { suggestionsCreated: 0, errors: [] };

  await processDuplicatePairs(ctx, userId, candidates.duplicatePairs, label, out);
  await processFuzzyPairs(ctx, userId, candidates.fuzzyPairs, label, out);

  if (out.suggestionsCreated > 0) {
    await ctx.runMutation(
      internal.contactResolution.incrementPendingActionCount,
      { userId, count: out.suggestionsCreated },
    );
  }

  return out;
}

/** Scan all contacts for merge candidates using handle + name matching. */
export const scanAllContactsForMerges = internalAction({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{
    comparisonsPerformed: number;
    suggestionsCreated: number;
    errors: string[];
  }> => {
    const candidates = await ctx.runQuery(
      internal.contactResolution.findDuplicateCandidatesInternal,
      { userId: args.userId },
    );

    const out = await processAndRecordCandidates(
      ctx, args.userId, candidates, "scanAllContactsForMerges",
    );

    const totalComparisons =
      candidates.duplicatePairs.length + candidates.fuzzyPairs.length;

    return {
      comparisonsPerformed: totalComparisons,
      suggestionsCreated: out.suggestionsCreated,
      errors: out.errors,
    };
  },
});

/** Check merge candidates for one contact (event-driven path). */
export const checkMergesForContact = internalAction({
  args: {
    userId: v.id("users"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args): Promise<{
    comparisonsPerformed: number;
    suggestionsCreated: number;
    errors: string[];
  }> => {
    const candidates = await ctx.runQuery(
      internal.contactResolution.findDuplicateCandidatesInternal,
      { userId: args.userId, contactId: args.contactId },
    );

    const out = await processAndRecordCandidates(
      ctx, args.userId, candidates, "checkMergesForContact",
    );

    return {
      comparisonsPerformed:
        candidates.duplicatePairs.length + candidates.fuzzyPairs.length,
      suggestionsCreated: out.suggestionsCreated,
      errors: out.errors,
    };
  },
});

/**
 * Find duplicate candidates using INDEX-BASED matching for handle and name overlap.
 * When contactId is provided, only returns pairs involving that contact (event-driven).
 * When omitted, returns all pairs (full-scan fallback).
 */
export const findDuplicateCandidatesInternal = internalQuery({
  args: {
    userId: v.id("users"),
    contactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args): Promise<DuplicateCandidateResult> => {
    if (args.contactId) {
      const targetContact = await ctx.db.get(args.contactId);
      if (!targetContact || targetContact.userId !== args.userId) {
        return { duplicatePairs: [], fuzzyPairs: [] };
      }
    }

    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const handles = await ctx.db
      .query("contactHandles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const contactIdToHandles = buildContactHandlesByContactId(handles);
    const handleToContacts = buildHandleToContactsIndex(contacts, handles);
    const nameTokenToContacts = buildNameTokenToContactsIndex(
      contacts,
      contactIdToHandles,
    );
    const contactIdToContact = new Map<Id<"contacts">, Doc<"contacts">>();
    for (const contact of contacts) {
      if (
        shouldIncludeContactInNameMatching(
          contact,
          contactIdToHandles.get(contact._id),
        )
      ) {
        contactIdToContact.set(contact._id, contact);
      }
    }

    return collectDuplicateCandidates(
      handleToContacts,
      nameTokenToContacts,
      contactIdToHandles,
      contactIdToContact,
      args.contactId,
    );
  },
});

/** Collect duplicate pairs from pre-built indexes, optionally scoped to one contact. */
function collectDuplicateCandidates(
  handleToContacts: Map<string, Set<Id<"contacts">>>,
  nameTokenToContacts: Map<string, Set<Id<"contacts">>>,
  contactIdToHandles: Map<Id<"contacts">, Doc<"contactHandles">[]>,
  contactIdToContact: Map<Id<"contacts">, Doc<"contacts">>,
  targetContactId?: Id<"contacts">,
): DuplicateCandidateResult {
  const duplicatePairs: DuplicatePair[] = [];
  const fuzzyPairs: DuplicatePair[] = [];
  const seenPairs = new Set<string>();

  // --- Handle-based duplicates ---
  for (const [handle, contactIds] of handleToContacts.entries()) {
    if (contactIds.size < 2) continue;
    if (targetContactId && !contactIds.has(targetContactId)) continue;

    const source = getDuplicateSourceForHandle(handle);

    if (targetContactId) {
      for (const otherId of contactIds) {
        if (otherId === targetContactId) continue;
        const pairKey = getPairKey(targetContactId, otherId);
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        duplicatePairs.push({
          contact1Id: targetContactId,
          contact2Id: otherId,
          confidence: 1.0,
          source,
          sharedHandle: handle,
        });
      }
    } else {
      const contactArray = Array.from(contactIds);
      for (let i = 0; i < contactArray.length; i++) {
        for (let j = i + 1; j < contactArray.length; j++) {
          const pairKey = getPairKey(contactArray[i], contactArray[j]);
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          duplicatePairs.push({
            contact1Id: contactArray[i],
            contact2Id: contactArray[j],
            confidence: 1.0,
            source,
            sharedHandle: handle,
          });
        }
      }
    }
  }

  // --- Name-based duplicates ---
  if (targetContactId) {
    const target = contactIdToContact.get(targetContactId);
    if (!target) return { duplicatePairs, fuzzyPairs };

    const nameCandidates = new Set<Id<"contacts">>();
    for (const token of getNameTokens(target.displayName)) {
      const bucket = nameTokenToContacts.get(token);
      if (!bucket || bucket.size < 2 || bucket.size > MAX_NAME_TOKEN_BUCKET_SIZE) continue;
      for (const id of bucket) {
        if (id !== targetContactId) nameCandidates.add(id);
      }
    }

    for (const candidateId of nameCandidates) {
      addNamePairIfValid(
        targetContactId, candidateId,
        seenPairs, contactIdToContact, contactIdToHandles,
        duplicatePairs, fuzzyPairs,
      );
    }
  } else {
    for (const [, contactIds] of nameTokenToContacts.entries()) {
      if (contactIds.size < 2 || contactIds.size > MAX_NAME_TOKEN_BUCKET_SIZE) continue;
      const contactArray = Array.from(contactIds);
      for (let i = 0; i < contactArray.length; i++) {
        for (let j = i + 1; j < contactArray.length; j++) {
          addNamePairIfValid(
            contactArray[i], contactArray[j],
            seenPairs, contactIdToContact, contactIdToHandles,
            duplicatePairs, fuzzyPairs,
          );
        }
      }
    }
  }

  return { duplicatePairs, fuzzyPairs };
}

/** Score a name pair and push to the appropriate result array if it passes thresholds. */
function addNamePairIfValid(
  id1: Id<"contacts">,
  id2: Id<"contacts">,
  seenPairs: Set<string>,
  contactIdToContact: Map<Id<"contacts">, Doc<"contacts">>,
  contactIdToHandles: Map<Id<"contacts">, Doc<"contactHandles">[]>,
  duplicatePairs: DuplicatePair[],
  fuzzyPairs: DuplicatePair[],
): void {
  const pairKey = getPairKey(id1, id2);
  if (seenPairs.has(pairKey)) return;

  const c1 = contactIdToContact.get(id1);
  const c2 = contactIdToContact.get(id2);
  if (!c1 || !c2) return;

  if (hasConflictingHandles(contactIdToHandles.get(id1), contactIdToHandles.get(id2))) {
    seenPairs.add(pairKey);
    return;
  }

  const score = nameSimilarity(c1.displayName, c2.displayName);
  if (score < NAME_MATCH_THRESHOLDS.MINIMUM) return;

  seenPairs.add(pairKey);
  const isExactMatch = score >= NAME_MATCH_THRESHOLDS.AUTO_MERGE;
  (isExactMatch ? duplicatePairs : fuzzyPairs).push({
    contact1Id: id1,
    contact2Id: id2,
    confidence: score,
    source: isExactMatch ? "exact_name_match" : "fuzzy_name_match",
  });
}

/** Trigger a full scan for merge candidates (user-facing). */
export const triggerMergeScan = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthenticatedUser(ctx);
    if (!user) throw new Error("Unauthorized");

    await ctx.scheduler.runAfter(
      0,
      internal.contactResolution.scanAllContactsForMerges,
      { userId: user._id },
    );

    return { success: true, message: "Merge scan scheduled" };
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
      v.literal("linkedin_urn_match"),
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
      .withIndex("by_contacts", (q) =>
        q.eq("contact1Id", c1).eq("contact2Id", c2),
      )
      .unique();

    if (existingSuggestion) {
      return { created: false, reason: "Suggestion already exists" };
    }

    // Also check for existing resolve_contact action for this pair
    const existingAction = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "pending"),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("type"), "resolve_contact"),
          q.eq(q.field("contactId"), c1),
          q.eq(q.field("secondaryContactId"), c2),
        ),
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
          `Failed to increment pendingActionCount by ${args.count}.`,
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
      v.literal("linkedin_urn_match"),
    ),
    reasoning: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
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
          q.eq("contactId", args.primaryContactId),
        )
        .collect(),
      ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) =>
          q.eq("contactId", args.secondaryContactId),
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
      primaryHandles.map((h) => buildHandleDedupKey(h.handleType, h.handle)),
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
          (id) => id !== secondaryContactId,
        );
        const hasPrimary =
          conv.participantContactIds.includes(primaryContactId);
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
        q.eq("senderContactId", secondaryContactId),
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

    // Resolve stale merge suggestions and actions that reference the
    // secondary contact before deleting it.
    const { affectedSuggestionIds, pairSuggestionIds } =
      await resolveStaleMergeSuggestions(
        ctx, primary.userId, primaryContactId, secondaryContactId, now,
      );

    const resolvedPendingActionCount = await resolveStaleActionsForMerge(
      ctx, primary.userId, primaryContactId, secondaryContactId,
      pairSuggestionIds, affectedSuggestionIds, now,
    );

    if (resolvedPendingActionCount > 0) {
      const user = await ctx.db.get(primary.userId);
      if (user) {
        await ctx.db.patch(primary.userId, {
          pendingActionCount: Math.max(
            0,
            (user.pendingActionCount ?? 0) - resolvedPendingActionCount,
          ),
        });
      }
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
      createdAt: now,
      resolvedAt: now,
    });

    // Schedule a follow-up merge check for the surviving contact so that
    // transitive duplicates (3+ contacts sharing a handle) coalesce fully.
    await scheduleContactMergeCheck(ctx, primary.userId, primaryContactId);

    return { success: true, handlesMovedCount: secondaryHandles.length };
  },
});

/**
 * Resolve pending merge suggestions that reference the secondary contact.
 * Approves the suggestion for the primary↔secondary pair, rejects others.
 */
async function resolveStaleMergeSuggestions(
  ctx: MutationCtx,
  userId: Id<"users">,
  primaryContactId: Id<"contacts">,
  secondaryContactId: Id<"contacts">,
  now: number,
): Promise<{
  affectedSuggestionIds: Set<Id<"mergeSuggestions">>;
  pairSuggestionIds: Set<Id<"mergeSuggestions">>;
}> {
  const pendingSuggestions = await ctx.db
    .query("mergeSuggestions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .collect();

  const affectedSuggestionIds = new Set<Id<"mergeSuggestions">>();
  const pairSuggestionIds = new Set<Id<"mergeSuggestions">>();

  for (const suggestion of pendingSuggestions) {
    const touchesSecondary =
      suggestion.contact1Id === secondaryContactId ||
      suggestion.contact2Id === secondaryContactId;
    if (!touchesSecondary) continue;

    const isThisMergePair =
      (suggestion.contact1Id === primaryContactId &&
        suggestion.contact2Id === secondaryContactId) ||
      (suggestion.contact1Id === secondaryContactId &&
        suggestion.contact2Id === primaryContactId);

    await ctx.db.patch(suggestion._id, {
      status: isThisMergePair ? "approved" : "rejected",
      resolvedAt: now,
    });

    affectedSuggestionIds.add(suggestion._id);
    if (isThisMergePair) pairSuggestionIds.add(suggestion._id);
  }

  return { affectedSuggestionIds, pairSuggestionIds };
}

/**
 * Rewrite or resolve actions that reference the secondary contact.
 *
 * 1. Actions whose primary contactId is the secondary → repoint to surviving
 *    contact, except pending resolve_contact actions which get resolved.
 * 2. Remaining pending resolve_contact actions that reference the secondary
 *    via secondaryContactId or an affected mergeSuggestionId also get resolved.
 *
 * Returns the total number of pending actions resolved (for pendingActionCount adjustment).
 */
async function resolveStaleActionsForMerge(
  ctx: MutationCtx,
  userId: Id<"users">,
  primaryContactId: Id<"contacts">,
  secondaryContactId: Id<"contacts">,
  pairSuggestionIds: Set<Id<"mergeSuggestions">>,
  affectedSuggestionIds: Set<Id<"mergeSuggestions">>,
  now: number,
): Promise<number> {
  let resolvedCount = 0;

  // Step 1: actions indexed by contactId === secondaryContactId
  const actionsBySecondary = await ctx.db
    .query("actions")
    .withIndex("by_contact", (q) => q.eq("contactId", secondaryContactId))
    .collect();

  const handledActionIds = new Set<Id<"actions">>();

  for (const action of actionsBySecondary) {
    if (action.type === "resolve_contact" && action.status === "pending") {
      const isThisMergePair =
        action.secondaryContactId === primaryContactId ||
        (!!action.mergeSuggestionId &&
          pairSuggestionIds.has(action.mergeSuggestionId));

      await ctx.db.patch(action._id, isThisMergePair
        ? { status: "completed", completedAt: now }
        : { status: "discarded", discardedAt: now });
      resolvedCount++;
      handledActionIds.add(action._id);
      continue;
    }

    // Non-resolve actions: repoint to the surviving contact
    await ctx.db.patch(action._id, { contactId: primaryContactId });
  }

  // Step 2: pending resolve_contact actions that reference the secondary via
  // secondaryContactId or an affected mergeSuggestionId (not caught above
  // because their contactId points elsewhere).
  const pendingResolveActions = await ctx.db
    .query("actions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .filter((q) => q.eq(q.field("type"), "resolve_contact"))
    .collect();

  for (const action of pendingResolveActions) {
    if (handledActionIds.has(action._id)) continue;

    const touchesSecondary =
      action.contactId === secondaryContactId ||
      action.secondaryContactId === secondaryContactId ||
      (!!action.mergeSuggestionId &&
        affectedSuggestionIds.has(action.mergeSuggestionId));
    if (!touchesSecondary) continue;

    const isThisMergePair =
      (action.contactId === primaryContactId &&
        action.secondaryContactId === secondaryContactId) ||
      (action.contactId === secondaryContactId &&
        action.secondaryContactId === primaryContactId) ||
      (!!action.mergeSuggestionId &&
        pairSuggestionIds.has(action.mergeSuggestionId));

    await ctx.db.patch(action._id, isThisMergePair
      ? { status: "completed", completedAt: now }
      : { status: "discarded", discardedAt: now });
    resolvedCount++;
  }

  return resolvedCount;
}

function buildHandleDedupKey(handleType: string, handle: string): string {
  const normalized = normalizeHandleValue(handleType, handle);
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
  handles: Doc<"contactHandles">[],
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
    handles.map((h) => buildHandleDedupKey(h.handleType, h.handle)),
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
        q.eq("userId", user._id).eq("status", "pending"),
      )
      .take(BATCH_SIZE);

    for (const suggestion of pendingSuggestions) {
      await ctx.db.delete(suggestion._id);
    }

    // Delete batch of pending resolve_contact actions
    const pendingActions = await ctx.db
      .query("actions")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", user._id).eq("status", "pending"),
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
          (user.pendingActionCount ?? 0) - pendingActions.length,
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

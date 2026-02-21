/**
 * LinkedIn sync operations.
 * Handles syncing conversations and messages from LinkedIn via Electron to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import {
  normalizeConversationURN,
  normalizeMemberURN,
  normalizeLinkedInHandle,
  urnIdsMatch,
  extractIdFromURN,
} from "@cued/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getOrCreateContact,
  type GetOrCreateContactResult,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
  getOrCreateIntegration,
  upsertSyncCursor,
  incrementSyncCursorStat,
  clearIntegrationError,
  MAX_NEW_CONNECTION_ACTIONS,
  extractCompanyFromHeadline,
  BATCH_SIZE,
  logSyncError,
  resolveMessageQueueBridge,
  buildContactAvatarPatch,
} from "./shared";
import {
  buildPrimaryAvatarFields,
  normalizeContactAvatarOption,
} from "../lib/avatar";
import { scheduleContactMergeCheck } from "../lib/contactMergeScheduling";
import { resolveActionSummary } from "../lib/actionSummary";

// ============================================================================
// Validators
// ============================================================================

/**
 * Participant in a LinkedIn conversation
 */
export const linkedInParticipantInput = v.object({
  entityURN: v.string(),
  firstName: v.string(),
  lastName: v.string(),
  profileUrl: v.string(),
  headline: v.optional(v.string()),
  pictureUrl: v.optional(v.string()),
});

/**
 * LinkedIn conversation input for batch sync
 */
export const linkedInConversationInput = v.object({
  entityURN: v.string(), // urn:li:fs_conversation:xxxx
  title: v.string(),
  lastActivityAt: v.number(), // Unix ms
  lastReadAt: v.number(), // Unix ms
  groupChat: v.boolean(),
  read: v.boolean(),
  categories: v.array(v.string()),
  unreadCount: v.number(),
  participants: v.array(linkedInParticipantInput),
});

/**
 * Attachment in a LinkedIn message
 */
export const linkedInAttachmentInput = v.object({
  type: v.union(
    v.literal("file"),
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
  ),
  name: v.optional(v.string()),
  url: v.string(),
  mediaType: v.optional(v.string()),
  size: v.optional(v.number()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  thumbnailUrl: v.optional(v.string()),
  duration: v.optional(v.number()),
});

/**
 * Reaction summary for a message
 */
export const linkedInReactionInput = v.object({
  emoji: v.string(),
  count: v.number(),
  viewerReacted: v.boolean(),
});

/**
 * LinkedIn message input for batch sync
 */
export const linkedInMessageInput = v.object({
  entityURN: v.string(), // urn:li:fs_message:xxxx
  conversationURN: v.string(), // urn:li:fs_conversation:xxxx
  text: v.string(),
  deliveredAt: v.number(), // Unix ms
  senderURN: v.string(),
  senderProfileUrl: v.optional(v.string()), // Profile URL if available
  senderPictureUrl: v.optional(v.string()), // Avatar URL if available
  senderFirstName: v.string(),
  senderLastName: v.string(),
  messageBodyRenderFormat: v.union(
    v.literal("DEFAULT"),
    v.literal("EDITED"),
    v.literal("RECALLED"),
    v.literal("SYSTEM"),
  ),
  attachments: v.optional(v.array(linkedInAttachmentInput)),
  reactions: v.optional(v.array(linkedInReactionInput)),
});

/**
 * Batch input for syncing conversations
 */
export const linkedInConversationsBatchInput = v.object({
  conversations: v.array(linkedInConversationInput),
  userURN: v.optional(v.string()), // User's LinkedIn URN for filtering self from title
});

/**
 * Batch input for syncing messages
 */
export const linkedInMessagesBatchInput = v.object({
  messages: v.array(linkedInMessageInput),
  userURN: v.optional(v.string()), // User's LinkedIn URN for isFromMe detection
});

// ============================================================================
// Types
// ============================================================================

export type LinkedInParticipantInput = Infer<typeof linkedInParticipantInput>;
export type LinkedInConversationInput = Infer<typeof linkedInConversationInput>;
export type LinkedInAttachmentInput = Infer<typeof linkedInAttachmentInput>;
export type LinkedInReactionInput = Infer<typeof linkedInReactionInput>;
export type LinkedInMessageInput = Infer<typeof linkedInMessageInput>;

// ============================================================================
// LinkedIn Sync Implementation
// ============================================================================

/**
 * Internal sync logic for LinkedIn conversations.
 * Upserts conversations and creates/links participant contacts.
 */
export async function syncLinkedInConversationsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversations: LinkedInConversationInput[],
  userURN?: string, // User's LinkedIn URN for filtering self from title
) {
  const result = {
    conversationsCount: 0,
    newConversations: 0,
    updatedConversations: 0,
    participantsLinked: 0,
    errors: [] as string[],
  };

  // Batch fetch existing conversations by entityURN (normalized)
  const conversationURNs = conversations.map((c) =>
    normalizeConversationURN(c.entityURN),
  );
  const existingConversations = await batchFetchLinkedInConversations(
    ctx,
    userId,
    conversationURNs,
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c]),
  );

  // Get user URN for filtering self from participant list
  const linkedInUserURN = await getUserLinkedInURN(ctx, userId, userURN);

  for (const conv of conversations) {
    try {
      // Normalize conversation URN to canonical format
      const normalizedURN = normalizeConversationURN(conv.entityURN);
      const existing = conversationMap.get(normalizedURN);

      // Resolve participants to contact IDs (filter out self)
      const participantContactIds: Id<"contacts">[] = [];
      const otherParticipantNames: string[] = [];
      for (const participant of conv.participants) {
        // Skip self when building participant list for display
        // Use URN ID comparison since LinkedIn uses different prefixes in different contexts
        const isSelf = urnIdsMatch(participant.entityURN, linkedInUserURN);
        if (isSelf) {
          continue;
        }

        const contactResult = await getOrCreateLinkedInContact(
          ctx,
          userId,
          participant,
        );
        participantContactIds.push(contactResult.contactId);
        result.participantsLinked++;

        // Collect names for display name generation
        const name = `${participant.firstName} ${participant.lastName}`.trim();
        if (name) {
          otherParticipantNames.push(name);
        }
      }

      // Build display name from other participants (not self)
      // For DMs: single name, for groups: comma-separated, fallback to title
      const displayName =
        otherParticipantNames.length > 0
          ? otherParticipantNames.join(", ")
          : conv.title || "LinkedIn Conversation";

      if (existing) {
        // Update existing conversation
        // Note: lastMessageAt is managed by message sync, not here
        // Setting it here would overwrite correct values with lastActivityAt
        await ctx.db.patch(existing._id, {
          displayName: displayName || existing.displayName,
          unreadCount: conv.unreadCount,
          participantContactIds,
        });
        result.updatedConversations++;
      } else {
        // Create new conversation (use normalized URN)
        await ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: normalizedURN,
          conversationType: conv.groupChat ? "group" : "dm",
          participantContactIds,
          unreadCount: conv.unreadCount,
          displayName,
          lastMessageAt: conv.lastActivityAt,
        });
        result.newConversations++;
      }

      result.conversationsCount++;
    } catch (e) {
      result.errors.push(
        logSyncError("LinkedIn", "sync conversation", conv.entityURN, e),
      );
    }
  }

  // Update integration with userURN if provided and clear any error
  const integration = await getOrCreateIntegration(ctx, userId, "linkedin");
  await ctx.db.patch(integration._id, {
    ...(userURN && { linkedInUserURN: userURN }),
    lastError: undefined,
  });

  // Update sync cursor with lastSyncAt
  await upsertSyncCursor(ctx, userId, "linkedin", {});

  return result;
}

/**
 * Internal sync logic for LinkedIn messages.
 * Upserts messages, resolves senders to contacts, updates conversation lastMessage.
 */
export async function syncLinkedInMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: LinkedInMessageInput[],
  userURN?: string, // User's LinkedIn URN for isFromMe detection
) {
  const result = {
    messagesCount: 0,
    newMessages: 0,
    skippedMessages: 0,
    errors: [] as string[],
  };

  if (messages.length === 0) {
    return result;
  }

  // Get user URN for isFromMe detection
  const linkedInUserURN = await getUserLinkedInURN(ctx, userId, userURN);

  // Group messages by conversation for efficient processing (use normalized URNs)
  const messagesByConversation = new Map<string, LinkedInMessageInput[]>();
  for (const msg of messages) {
    const normalizedConvURN = normalizeConversationURN(msg.conversationURN);
    const existing = messagesByConversation.get(normalizedConvURN) ?? [];
    existing.push(msg);
    messagesByConversation.set(normalizedConvURN, existing);
  }

  // Batch fetch existing conversations
  const conversationURNs = [...messagesByConversation.keys()];
  const existingConversations = await batchFetchLinkedInConversations(
    ctx,
    userId,
    conversationURNs,
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id]),
  );
  // Track existing lastMessageAt to avoid overwriting with older timestamps
  const existingLastMessageAt = new Map(
    existingConversations
      .filter((c) => c.lastMessageAt !== undefined)
      .map((c) => [c._id, c.lastMessageAt!]),
  );

  // Batch fetch existing messages for deduplication
  const messageURNs = messages.map((m) => m.entityURN);
  const existingMessages = await batchFetchLinkedInMessages(
    ctx,
    userId,
    messageURNs,
  );
  const existingMessageSet = new Set(
    existingMessages.map((m) => m.platformMessageId),
  );

  // Track conversations with recent incoming/outgoing messages for action analysis
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();
  const outgoingConvos = new Set<Id<"conversations">>();

  for (const [conversationURN, convMessages] of messagesByConversation) {
    let conversationId = conversationMap.get(conversationURN);

    // Create conversation if it doesn't exist
    if (!conversationId) {
      conversationId = await ctx.db.insert("conversations", {
        userId,
        platform: "linkedin",
        platformConversationId: conversationURN,
        conversationType: "dm", // Default to DM, will be updated when conversation syncs
        participantContactIds: [],
        unreadCount: 0,
      });
      conversationMap.set(conversationURN, conversationId);
    }

    let latestMessage: { text: string; timestamp: number } | null = null;
    let hasRecentIncoming = false;

    for (const msg of convMessages) {
      try {
        // Skip if already exists (deduplication)
        if (existingMessageSet.has(msg.entityURN)) {
          result.skippedMessages++;
          continue;
        }

        // Skip system/recalled messages
        if (
          msg.messageBodyRenderFormat === "RECALLED" ||
          msg.messageBodyRenderFormat === "SYSTEM"
        ) {
          result.skippedMessages++;
          continue;
        }

        // Detect if message is from the user by comparing URN IDs
        // LinkedIn uses different URN prefixes in different contexts (fsd_profile vs fs_miniProfile)
        // but the ID portion is consistent
        const isFromMe = urnIdsMatch(msg.senderURN, linkedInUserURN);

        // Resolve sender to contact (if not from me)
        let senderContactId: Id<"contacts"> | undefined;
        let senderHandleId: Id<"contactHandles"> | undefined;
        if (!isFromMe) {
          const senderResult = await getOrCreateLinkedInContactByURN(
            ctx,
            userId,
            msg.senderURN,
            msg.senderFirstName,
            msg.senderLastName,
            msg.senderProfileUrl,
            msg.senderPictureUrl,
          );
          senderContactId = senderResult.contactId;
          senderHandleId = senderResult.handleId;

          // Track for action analysis if recent incoming
          if (msg.deliveredAt >= cutoff) {
            hasRecentIncoming = true;
          }
        } else {
          // Track for action analysis if recent outgoing (auto-complete)
          if (msg.deliveredAt >= cutoff) {
            outgoingConvos.add(conversationId);
          }
        }

        const bridge = isFromMe
          ? await resolveMessageQueueBridge(
              ctx,
              userId,
              conversationId,
              msg.text,
              isFromMe,
              msg.deliveredAt
            )
          : { status: undefined, sentAt: undefined };
        const sentAt = bridge.sentAt ?? msg.deliveredAt;

        // Insert message
        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "linkedin",
          content: msg.text,
          sentAt,
          senderContactId,
          senderHandleId,
          isFromMe,
          platformMessageId: msg.entityURN,
          status: bridge.status,
        });

        result.newMessages++;
        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || sentAt > latestMessage.timestamp) {
          latestMessage = { text: msg.text, timestamp: sentAt };
        }
      } catch (e) {
        result.errors.push(
          logSyncError("LinkedIn", "sync message", msg.entityURN, e),
        );
      }
    }

    // Update conversation lastMessage (only if newer than existing)
    // This prevents older message batches from overwriting newer timestamps
    if (latestMessage) {
      const existingTimestamp = existingLastMessageAt.get(conversationId);
      if (
        existingTimestamp === undefined ||
        latestMessage.timestamp > existingTimestamp
      ) {
        await ctx.db.patch(conversationId, {
          lastMessageText: latestMessage.text,
          lastMessageAt: latestMessage.timestamp,
        });
        // Update tracking map for subsequent batches within same sync cycle
        existingLastMessageAt.set(conversationId, latestMessage.timestamp);
      }
    }

    // Track for action analysis
    if (hasRecentIncoming) {
      incomingConvos.add(conversationId);
    }
  }

  // Schedule action analysis for conversations with new messages
  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "linkedin");
  await scheduleOutgoingMessageEvents(ctx, userId, outgoingConvos);

  // Update integration with userURN if provided and clear any error
  const integration = await getOrCreateIntegration(ctx, userId, "linkedin");
  await ctx.db.patch(integration._id, {
    ...(userURN && { linkedInUserURN: userURN }),
    lastError: undefined,
  });

  // Update sync cursor with stats
  await incrementSyncCursorStat(
    ctx,
    userId,
    "linkedin",
    "totalMessagesSynced",
    result.newMessages,
  );

  return result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the user's LinkedIn URN, either from the provided parameter or from the integration record.
 */
async function getUserLinkedInURN(
  ctx: MutationCtx,
  userId: Id<"users">,
  providedURN?: string,
): Promise<string | undefined> {
  if (providedURN) return providedURN;

  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", "linkedin"),
    )
    .unique();
  return integration?.linkedInUserURN;
}

function isLinkedInProfileUrl(value: string): boolean {
  return /linkedin\.com\/in\//i.test(value);
}

function isLikelyLinkedInMemberId(value: string): boolean {
  return /^ACo[A-Za-z0-9_-]{8,}$/i.test(value);
}

/**
 * Normalize a potential LinkedIn username value while filtering out opaque member IDs.
 * LinkedIn messaging payloads may provide member IDs in profileUrl fields.
 */
function normalizeNonOpaqueLinkedInHandle(value: string): string {
  const normalized = normalizeLinkedInHandle(value);
  if (!normalized) return "";
  if (isLinkedInProfileUrl(value)) return normalized;
  return isLikelyLinkedInMemberId(normalized) ? "" : normalized;
}

/**
 * Get or create a LinkedIn contact by URN and optional profile URL.
 * Stores URN as stable identifier (for deduplication) and normalized slug (for display).
 * Uses unified getOrCreateContact from shared.ts.
 */
async function getOrCreateLinkedInContactInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  urn: string,
  firstName: string,
  lastName: string,
  profileUrl?: string,
  pictureUrl?: string,
  fallbackName?: string,
): Promise<GetOrCreateContactResult> {
  const normalizedURN = normalizeMemberURN(urn).toLowerCase();
  const handles: { value: string; type: "linkedin_urn" | "linkedin_handle" }[] =
    [{ value: normalizedURN, type: "linkedin_urn" }];

  // Add normalized slug if profile URL is available
  if (profileUrl && profileUrl.trim()) {
    const normalizedSlug = normalizeNonOpaqueLinkedInHandle(profileUrl);
    if (normalizedSlug) {
      handles.push({ value: normalizedSlug, type: "linkedin_handle" });
    }
  }

  const displayName =
    `${firstName} ${lastName}`.trim() || fallbackName || "LinkedIn User";
  const result = await getOrCreateContact(
    ctx,
    userId,
    "linkedin",
    handles,
    displayName,
    {
      avatar: pictureUrl
        ? {
            url: pictureUrl,
            sourcePlatform: "linkedin",
          }
        : undefined,
    },
  );
  if (!result) {
    throw new Error(`Failed to create LinkedIn contact for ${displayName}`);
  }
  return result;
}

/**
 * Get or create a contact for a LinkedIn participant.
 */
async function getOrCreateLinkedInContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  participant: LinkedInParticipantInput,
): Promise<GetOrCreateContactResult> {
  return getOrCreateLinkedInContactInternal(
    ctx,
    userId,
    participant.entityURN,
    participant.firstName,
    participant.lastName,
    participant.profileUrl,
    participant.pictureUrl,
  );
}

/**
 * Get or create a contact from sender info (used in message sync).
 */
async function getOrCreateLinkedInContactByURN(
  ctx: MutationCtx,
  userId: Id<"users">,
  senderURN: string,
  firstName: string,
  lastName: string,
  profileUrl?: string,
  pictureUrl?: string,
): Promise<GetOrCreateContactResult> {
  return getOrCreateLinkedInContactInternal(
    ctx,
    userId,
    senderURN,
    firstName,
    lastName,
    profileUrl,
    pictureUrl,
    senderURN, // Fallback to URN if no name
  );
}

// ============================================================================
// Batch Fetch Helpers
// ============================================================================

/**
 * Batch fetch existing LinkedIn conversations by entityURN.
 */
async function batchFetchLinkedInConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationURNs: string[],
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  for (let i = 0; i < conversationURNs.length; i += BATCH_SIZE) {
    const batch = conversationURNs.slice(i, i + BATCH_SIZE);
    const promises = batch.map((urn) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "linkedin")
            .eq("platformConversationId", urn),
        )
        .unique(),
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((c): c is Doc<"conversations"> => c !== null),
    );
  }

  return results;
}

/**
 * Batch fetch existing LinkedIn messages by entityURN.
 */
async function batchFetchLinkedInMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageURNs: string[],
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  for (let i = 0; i < messageURNs.length; i += BATCH_SIZE) {
    const batch = messageURNs.slice(i, i + BATCH_SIZE);
    const promises = batch.map((urn) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "linkedin")
            .eq("platformMessageId", urn),
        )
        .unique(),
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((m): m is Doc<"messages"> => m !== null),
    );
  }

  return results;
}

// ============================================================================
// Username Resolution (Public Identifier Lookup)
// ============================================================================

/**
 * Validator for username resolution input
 */
export const usernameResolutionInput = v.object({
  memberId: v.string(), // URN ID portion, e.g., "ACoAAEFsIqIB..."
  publicIdentifier: v.string(), // Vanity URL, e.g., "theotarr"
});

/**
 * Find LinkedIn contacts that only have URN handles (missing username).
 * Returns contacts that need profile lookup to resolve their public identifier.
 *
 * @param ctx - Mutation context
 * @param userId - User ID
 * @param limit - Maximum number of contacts to return (default 50)
 * @returns Contacts needing username resolution, with their URN member ID
 */
export async function findContactsMissingUsernames(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number = 50,
): Promise<
  Array<{ contactId: Id<"contacts">; memberId: string; displayName: string }>
> {
  // Get all handles for this user and filter for LinkedIn URNs
  const allHandles = await ctx.db
    .query("contactHandles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  // Filter for LinkedIn URN handles
  const urnHandles = allHandles.filter(
    (h) => h.platform === "linkedin" && h.handleType === "linkedin_urn",
  );

  const contactsNeedingResolution: Array<{
    contactId: Id<"contacts">;
    memberId: string;
    displayName: string;
  }> = [];

  // Build a set of contact IDs that already have linkedin_handle handles
  const contactsWithUsernames = new Set(
    allHandles
      .filter(
        (h) =>
          h.platform === "linkedin" &&
          h.handleType === "linkedin_handle" &&
          !isLikelyLinkedInMemberId(h.handle),
      )
      .map((h) => h.contactId.toString()),
  );

  for (const urnHandle of urnHandles) {
    if (contactsNeedingResolution.length >= limit) break;

    // Skip if this contact already has a username handle
    if (contactsWithUsernames.has(urnHandle.contactId.toString())) {
      continue;
    }

    // Extract member ID from URN using shared utility
    const memberId = extractIdFromURN(urnHandle.handle);
    if (memberId) {
      const contact = await ctx.db.get(urnHandle.contactId);
      contactsNeedingResolution.push({
        contactId: urnHandle.contactId,
        memberId,
        displayName: contact?.displayName ?? "Unknown",
      });
    }
  }

  return contactsNeedingResolution;
}

/**
 * Add username handles to LinkedIn contacts that were resolved via profile lookup.
 *
 * @param ctx - Mutation context
 * @param userId - User ID
 * @param resolutions - Array of resolved member ID -> public identifier mappings
 * @returns Number of handles added
 */
export async function addResolvedUsernames(
  ctx: MutationCtx,
  userId: Id<"users">,
  resolutions: Array<Infer<typeof usernameResolutionInput>>,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;

  for (const { memberId, publicIdentifier } of resolutions) {
    // Skip empty public identifiers
    if (!publicIdentifier || publicIdentifier.trim() === "") {
      skipped++;
      continue;
    }

    // Normalize the public identifier
    const normalizedUsername = normalizeLinkedInHandle(publicIdentifier);
    if (
      !normalizedUsername ||
      isLikelyLinkedInMemberId(normalizedUsername)
    ) {
      skipped++;
      continue;
    }

    // Find the URN handle for this member ID (try both formats)
    const urnFormats = [
      `urn:li:member:${memberId}`.toLowerCase(),
      `urn:li:fsd_profile:${memberId}`.toLowerCase(),
    ];

    let contactId: Id<"contacts"> | null = null;
    for (const urnValue of urnFormats) {
      const handle = await ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) =>
          q.eq("userId", userId).eq("handle", urnValue),
        )
        .first();
      if (handle) {
        contactId = handle.contactId;
        break;
      }
    }

    if (!contactId) {
      skipped++;
      continue;
    }

    // Check if username already exists
    const existingUsername = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", normalizedUsername),
      )
      .first();

    if (existingUsername) {
      skipped++;
      continue;
    }

    // Remove legacy opaque IDs that were previously stored as linkedin_handle.
    const contactHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect();
    for (const handle of contactHandles) {
      if (
        handle.platform === "linkedin" &&
        handle.handleType === "linkedin_handle" &&
        isLikelyLinkedInMemberId(handle.handle)
      ) {
        await ctx.db.delete(handle._id);
      }
    }

    // Add the linkedin_handle handle
    await ctx.db.insert("contactHandles", {
      userId,
      contactId,
      handleType: "linkedin_handle",
      handle: normalizedUsername,
      platform: "linkedin",
    });
    await scheduleContactMergeCheck(ctx, userId, contactId);
    added++;
  }

  return { added, skipped };
}

// ============================================================================
// LinkedIn Contacts Sync
// ============================================================================

export const linkedInContactInput = v.object({
  name: v.string(),
  profileUrl: v.string(),
  headline: v.union(v.string(), v.null()),
  profileId: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
});

export const linkedInContactsBatchInput = v.object({
  contacts: v.array(linkedInContactInput),
});

type LinkedInContactInput = Infer<typeof linkedInContactInput>;

export async function syncLinkedInContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  contacts: LinkedInContactInput[],
) {
  const result = {
    totalContacts: contacts.length,
    newContacts: 0,
    updatedContacts: 0,
    actionsCreated: 0,
    errors: [] as string[],
    duplicatesSkipped: 0,
  };

  // Deduplicate within batch by normalized LinkedIn handle
  const seenHandles = new Set<string>();
  const deduped: LinkedInContactInput[] = [];
  for (const contact of contacts) {
    const normalized = normalizeNonOpaqueLinkedInHandle(contact.profileUrl);
    if (normalized && seenHandles.has(normalized)) {
      result.duplicatesSkipped++;
      continue;
    }
    if (normalized) {
      seenHandles.add(normalized);
    }
    deduped.push(contact);
  }

  const newContactsInfo: Array<{
    contactId: Id<"contacts">;
    headline: string | null;
    profileUrl: string;
  }> = [];

  for (const contact of deduped) {
    try {
      const normalizedHandle = normalizeNonOpaqueLinkedInHandle(
        contact.profileUrl,
      );
      const linkedInUrn = contact.profileId
        ? `urn:li:member:${contact.profileId}`.toLowerCase()
        : null;
      let mergeCheckContactId: Id<"contacts"> | null = null;

      // Try to find existing contact by username handle first
      let existingHandle = normalizedHandle
        ? await ctx.db
            .query("contactHandles")
            .withIndex("by_user_handle", (q) =>
              q.eq("userId", userId).eq("handle", normalizedHandle),
            )
            .unique()
        : null;

      // Fallback: find by URN
      if (!existingHandle && linkedInUrn) {
        existingHandle = await ctx.db
          .query("contactHandles")
          .withIndex("by_user_handle", (q) =>
            q.eq("userId", userId).eq("handle", linkedInUrn),
          )
          .unique();
      }

      if (existingHandle) {
        const existingContact = await ctx.db.get(existingHandle.contactId);
        if (existingContact) {
          const contactPatch: Partial<Doc<"contacts">> = {};
          const company = extractCompanyFromHeadline(contact.headline);
          if (company && !existingContact.company) {
            contactPatch.company = company;
          }

          const avatarPatch = buildContactAvatarPatch(
            existingContact,
            contact.avatarUrl
              ? {
                  url: contact.avatarUrl,
                  sourcePlatform: "linkedin",
                }
              : undefined,
          );
          if (avatarPatch) {
            Object.assign(contactPatch, avatarPatch);
          }

          if (Object.keys(contactPatch).length > 0) {
            await ctx.db.patch(existingHandle.contactId, contactPatch);
          }
          // If found by URN but missing username handle, add it
          if (normalizedHandle && existingHandle.handle !== normalizedHandle) {
            const hasUsernameHandle = await ctx.db
              .query("contactHandles")
              .withIndex("by_user_handle", (q) =>
                q.eq("userId", userId).eq("handle", normalizedHandle),
              )
              .unique();
            if (!hasUsernameHandle) {
              await ctx.db.insert("contactHandles", {
                userId,
                contactId: existingHandle.contactId,
                handleType: "linkedin_handle",
                handle: normalizedHandle,
                platform: "linkedin",
              });
              mergeCheckContactId = existingHandle.contactId;
            }
          }
        }
        result.updatedContacts++;
      } else {
        // Create new contact
        const company = extractCompanyFromHeadline(contact.headline);
        const avatarOption = contact.avatarUrl
          ? normalizeContactAvatarOption({
              url: contact.avatarUrl,
              sourcePlatform: "linkedin",
            })
          : undefined;
        const avatarOptions = avatarOption ? [avatarOption] : [];
        const contactId = await ctx.db.insert("contacts", {
          userId,
          displayName: contact.name,
          company,
          ...buildPrimaryAvatarFields(avatarOptions),
          avatarOptions: avatarOptions.length > 0 ? avatarOptions : undefined,
        });

        if (normalizedHandle) {
          await ctx.db.insert("contactHandles", {
            userId,
            contactId,
            handleType: "linkedin_handle",
            handle: normalizedHandle,
            platform: "linkedin",
          });
        }

        if (linkedInUrn) {
          await ctx.db.insert("contactHandles", {
            userId,
            contactId,
            handleType: "linkedin_urn",
            handle: linkedInUrn,
            platform: "linkedin",
          });
        }

        mergeCheckContactId = contactId;

        result.newContacts++;
        newContactsInfo.push({
          contactId,
          headline: contact.headline,
          profileUrl: contact.profileUrl,
        });
      }

      if (mergeCheckContactId) {
        await scheduleContactMergeCheck(ctx, userId, mergeCheckContactId);
      }
    } catch (e) {
      result.errors.push(
        logSyncError("LinkedIn", "sync contact", contact.name, e),
      );
    }
  }

  // Create new_connection actions (limit per sync)
  const actionsToCreate = newContactsInfo.slice(0, MAX_NEW_CONNECTION_ACTIONS);
  const now = Date.now();

  for (const info of actionsToCreate) {
    await ctx.db.insert("actions", {
      userId,
      type: "new_connection",
      status: "pending",
      priority: 40,
      contactId: info.contactId,
      platform: "linkedin",
      summary: resolveActionSummary("new_connection"),
      llmReason: info.headline ?? undefined,
      reason: info.profileUrl,
      createdAt: now,
    });
    result.actionsCreated++;
  }

  if (result.actionsCreated > 0) {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        pendingActionCount:
          (user.pendingActionCount ?? 0) + result.actionsCreated,
      });
    }
  }

  await incrementSyncCursorStat(
    ctx,
    userId,
    "linkedin",
    "totalContactsSynced",
    result.newContacts,
  );
  await getOrCreateIntegration(ctx, userId, "linkedin");
  await clearIntegrationError(ctx, userId, "linkedin");

  return result;
}

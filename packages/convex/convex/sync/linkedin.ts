/**
 * LinkedIn sync operations.
 * Handles syncing conversations and messages from LinkedIn via Electron to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import {
  normalizeConversationURN,
  normalizeMemberURN,
  urnIdsMatch,
} from "@prm/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getOrCreateContact,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
  getOrCreateIntegration,
  normalizeLinkedInHandle,
  upsertSyncCursor,
  incrementSyncCursorStat,
  BATCH_SIZE,
  logSyncError,
} from "./shared";

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
    v.literal("audio")
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
  senderFirstName: v.string(),
  senderLastName: v.string(),
  messageBodyRenderFormat: v.union(
    v.literal("DEFAULT"),
    v.literal("EDITED"),
    v.literal("RECALLED"),
    v.literal("SYSTEM")
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
  userURN?: string // User's LinkedIn URN for filtering self from title
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
    normalizeConversationURN(c.entityURN)
  );
  const existingConversations = await batchFetchLinkedInConversations(
    ctx,
    userId,
    conversationURNs
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c])
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

        const contactId = await getOrCreateLinkedInContact(
          ctx,
          userId,
          participant
        );
        participantContactIds.push(contactId);
        result.participantsLinked++;

        // Collect names for display name generation
        const name = `${participant.firstName} ${participant.lastName}`.trim();
        if (name) {
          otherParticipantNames.push(name);
        }
      }

      // Build display name from other participants (not self)
      // For DMs: just the other person's name
      // For groups: comma-separated names or fallback to original title
      let displayName: string;
      if (!conv.groupChat && otherParticipantNames.length === 1) {
        displayName = otherParticipantNames[0];
      } else if (otherParticipantNames.length > 0) {
        displayName = otherParticipantNames.join(", ");
      } else {
        displayName = conv.title || "LinkedIn Conversation";
      }

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
      result.errors.push(logSyncError("LinkedIn", "sync conversation", conv.entityURN, e));
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
  userURN?: string // User's LinkedIn URN for isFromMe detection
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
    conversationURNs
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );
  // Track existing lastMessageAt to avoid overwriting with older timestamps
  const existingLastMessageAt = new Map(
    existingConversations
      .filter((c) => c.lastMessageAt !== undefined)
      .map((c) => [c._id, c.lastMessageAt!])
  );

  // Batch fetch existing messages for deduplication
  const messageURNs = messages.map((m) => m.entityURN);
  const existingMessages = await batchFetchLinkedInMessages(
    ctx,
    userId,
    messageURNs
  );
  const existingMessageSet = new Set(
    existingMessages.map((m) => m.platformMessageId)
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
        if (!isFromMe) {
          senderContactId = await getOrCreateLinkedInContactByURN(
            ctx,
            userId,
            msg.senderURN,
            msg.senderFirstName,
            msg.senderLastName,
            msg.senderProfileUrl
          );

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

        // Insert message
        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "linkedin",
          content: msg.text,
          sentAt: msg.deliveredAt,
          senderContactId,
          isFromMe,
          platformMessageId: msg.entityURN,
          // LinkedIn messages don't have thread structure
        });

        result.newMessages++;
        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || msg.deliveredAt > latestMessage.timestamp) {
          latestMessage = { text: msg.text, timestamp: msg.deliveredAt };
        }
      } catch (e) {
        result.errors.push(logSyncError("LinkedIn", "sync message", msg.entityURN, e));
      }
    }

    // Update conversation lastMessage (only if newer than existing)
    // This prevents older message batches from overwriting newer timestamps
    if (latestMessage) {
      const existingTimestamp = existingLastMessageAt.get(conversationId);
      if (existingTimestamp === undefined || latestMessage.timestamp > existingTimestamp) {
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
  await incrementSyncCursorStat(ctx, userId, "linkedin", "totalMessagesSynced", result.newMessages);

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
  providedURN?: string
): Promise<string | undefined> {
  if (providedURN) return providedURN;

  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", "linkedin")
    )
    .unique();
  return integration?.linkedInUserURN;
}

/**
 * Get or create a contact for a LinkedIn participant.
 * Always stores URN as stable identifier, plus normalized slug if profileUrl available.
 * This prevents duplicate contacts when profileUrl becomes available after initial sync.
 * Uses unified getOrCreateContact from shared.ts.
 */
async function getOrCreateLinkedInContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  participant: LinkedInParticipantInput
): Promise<Id<"contacts">> {
  // Normalize and store URN as stable identifier (for deduplication)
  const normalizedURN = normalizeMemberURN(participant.entityURN).toLowerCase();
  const handles: { value: string; type: "linkedin_urn" | "linkedin_handle" }[] = [
    { value: normalizedURN, type: "linkedin_urn" },
  ];

  // If profile URL available, also store normalized slug (for display)
  if (participant.profileUrl) {
    const normalizedSlug = normalizeLinkedInHandle(participant.profileUrl);
    handles.push({ value: normalizedSlug, type: "linkedin_handle" });
  }

  const displayName = `${participant.firstName} ${participant.lastName}`.trim();
  const result = await getOrCreateContact(
    ctx,
    userId,
    "linkedin",
    handles,
    displayName || "LinkedIn User"
  );
  return result.contactId;
}

/**
 * Get or create a contact from sender info (used in message sync).
 * Always stores URN as stable identifier, plus normalized slug if profileUrl available.
 * This prevents duplicate contacts when profileUrl becomes available after initial sync.
 * Uses unified getOrCreateContact from shared.ts.
 */
async function getOrCreateLinkedInContactByURN(
  ctx: MutationCtx,
  userId: Id<"users">,
  senderURN: string,
  firstName: string,
  lastName: string,
  profileUrl?: string
): Promise<Id<"contacts">> {
  // Normalize and store URN as stable identifier (for deduplication)
  const normalizedURN = normalizeMemberURN(senderURN).toLowerCase();
  const handles: { value: string; type: "linkedin_urn" | "linkedin_handle" }[] = [
    { value: normalizedURN, type: "linkedin_urn" },
  ];

  // If profile URL available, also store normalized slug (for display)
  const hasProfileUrl = profileUrl && profileUrl.trim().length > 0;
  if (hasProfileUrl) {
    const normalizedSlug = normalizeLinkedInHandle(profileUrl);
    handles.push({ value: normalizedSlug, type: "linkedin_handle" });
  }

  const displayName = `${firstName} ${lastName}`.trim();
  const result = await getOrCreateContact(
    ctx,
    userId,
    "linkedin",
    handles,
    displayName || senderURN
  );
  return result.contactId;
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
  conversationURNs: string[]
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
            .eq("platformConversationId", urn)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((c): c is Doc<"conversations"> => c !== null)
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
  messageURNs: string[]
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
            .eq("platformMessageId", urn)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(
      ...batchResults.filter((m): m is Doc<"messages"> => m !== null)
    );
  }

  return results;
}

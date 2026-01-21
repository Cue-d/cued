/**
 * LinkedIn sync operations.
 * Handles syncing conversations and messages from LinkedIn via Electron to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  scheduleIncomingMessageEvents,
  SEVEN_DAYS_MS,
  getOrCreateIntegration,
  normalizeLinkedInUrl,
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
});

/**
 * Batch input for syncing messages
 */
export const linkedInMessagesBatchInput = v.object({
  messages: v.array(linkedInMessageInput),
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
  conversations: LinkedInConversationInput[]
) {
  const result = {
    conversationsCount: 0,
    newConversations: 0,
    updatedConversations: 0,
    participantsLinked: 0,
    errors: [] as string[],
  };

  // Batch fetch existing conversations by entityURN
  const conversationURNs = conversations.map((c) => c.entityURN);
  const existingConversations = await batchFetchLinkedInConversations(
    ctx,
    userId,
    conversationURNs
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c])
  );

  for (const conv of conversations) {
    try {
      const existing = conversationMap.get(conv.entityURN);

      // Resolve participants to contact IDs
      const participantContactIds: Id<"contacts">[] = [];
      for (const participant of conv.participants) {
        const contactId = await getOrCreateLinkedInContact(
          ctx,
          userId,
          participant
        );
        participantContactIds.push(contactId);
        result.participantsLinked++;
      }

      if (existing) {
        // Update existing conversation
        await ctx.db.patch(existing._id, {
          displayName: conv.title || existing.displayName,
          lastMessageAt: conv.lastActivityAt,
          unreadCount: conv.unreadCount,
          participantContactIds,
        });
        result.updatedConversations++;
      } else {
        // Create new conversation
        await ctx.db.insert("conversations", {
          userId,
          platform: "linkedin",
          platformConversationId: conv.entityURN,
          conversationType: conv.groupChat ? "group" : "dm",
          participantContactIds,
          unreadCount: conv.unreadCount,
          displayName: conv.title,
          lastMessageAt: conv.lastActivityAt,
        });
        result.newConversations++;
      }

      result.conversationsCount++;
    } catch (e) {
      result.errors.push(`Failed to sync conversation ${conv.entityURN}: ${e}`);
    }
  }

  // Update integration sync state
  const integration = await getOrCreateIntegration(ctx, userId, "linkedin");
  await ctx.db.patch(integration._id, {
    syncState: {
      ...integration.syncState,
      lastSyncAt: Date.now(),
      lastError: undefined,
    },
  });

  return result;
}

/**
 * Internal sync logic for LinkedIn messages.
 * Upserts messages, resolves senders to contacts, updates conversation lastMessage.
 */
export async function syncLinkedInMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: LinkedInMessageInput[]
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

  // Group messages by conversation for efficient processing
  const messagesByConversation = new Map<string, LinkedInMessageInput[]>();
  for (const msg of messages) {
    const existing = messagesByConversation.get(msg.conversationURN) ?? [];
    existing.push(msg);
    messagesByConversation.set(msg.conversationURN, existing);
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


  // Track conversations with recent incoming messages for action analysis
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();

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

        // TODO: Implement isFromMe detection when user's LinkedIn URN is stored
        const isFromMe = false;

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

          // Track for action analysis if recent
          if (msg.deliveredAt >= cutoff) {
            hasRecentIncoming = true;
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
        result.errors.push(`Failed to sync message ${msg.entityURN}: ${e}`);
      }
    }

    // Update conversation lastMessage
    if (latestMessage) {
      await ctx.db.patch(conversationId, {
        lastMessageText: latestMessage.text,
        lastMessageAt: latestMessage.timestamp,
      });
    }

    // Track for action analysis
    if (hasRecentIncoming) {
      incomingConvos.add(conversationId);
    }
  }

  // Schedule action analysis for conversations with new incoming messages
  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "linkedin");

  // Update integration sync state with message count
  const integration = await getOrCreateIntegration(ctx, userId, "linkedin");
  await ctx.db.patch(integration._id, {
    syncState: {
      ...integration.syncState,
      lastSyncAt: Date.now(),
      lastError: undefined,
      totalMessagesSynced:
        (integration.syncState.totalMessagesSynced ?? 0) + result.newMessages,
    },
  });

  return result;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get or create a contact for a LinkedIn participant.
 * Links contact by LinkedIn profile URL.
 */
async function getOrCreateLinkedInContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  participant: LinkedInParticipantInput
): Promise<Id<"contacts">> {
  // Normalize profile URL for consistent lookups
  const normalizedHandle = normalizeLinkedInUrl(participant.profileUrl);

  // Check if we already have a handle for this LinkedIn user
  // NOTE: Using .first() instead of .unique() to handle duplicates gracefully
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", normalizedHandle)
    )
    .first();

  if (existingHandle) {
    // Update contact info if we have better data
    const existingContact = await ctx.db.get(existingHandle.contactId);
    if (existingContact) {
      const displayName = `${participant.firstName} ${participant.lastName}`.trim();
      if (displayName && existingContact.displayName !== displayName) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create new contact
  const displayName = `${participant.firstName} ${participant.lastName}`.trim();
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || "LinkedIn User",
  });

  // Create handle for LinkedIn profile URL
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "linkedin_url",
    handle: normalizedHandle,
    platform: "linkedin",
  });

  return contactId;
}

/**
 * Get or create a contact from sender info (preferring profileUrl over URN).
 * Used when syncing messages - prefers profileUrl for deduplication with connections.
 */
async function getOrCreateLinkedInContactByURN(
  ctx: MutationCtx,
  userId: Id<"users">,
  senderURN: string,
  firstName: string,
  lastName: string,
  profileUrl?: string
): Promise<Id<"contacts">> {
  // Prefer profile URL over URN for handle (matches connections sync format)
  const hasProfileUrl = profileUrl && profileUrl.trim().length > 0;
  const normalizedHandle = hasProfileUrl
    ? normalizeLinkedInUrl(profileUrl)
    : senderURN.toLowerCase();

  // Check if we already have a handle for this user
  // NOTE: Using .first() instead of .unique() to handle duplicates gracefully
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", normalizedHandle)
    )
    .first();

  if (existingHandle) {
    // Update display name if we have a better one
    const existingContact = await ctx.db.get(existingHandle.contactId);
    if (existingContact) {
      const displayName = `${firstName} ${lastName}`.trim();
      if (
        displayName &&
        existingContact.displayName !== displayName &&
        existingContact.displayName === senderURN
      ) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create new contact
  const displayName = `${firstName} ${lastName}`.trim();
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || senderURN,
  });

  // Create handle (URL preferred, fallback to URN)
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "linkedin_url",
    handle: normalizedHandle,
    platform: "linkedin",
  });

  return contactId;
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

  const batchSize = 50;
  for (let i = 0; i < conversationURNs.length; i += batchSize) {
    const batch = conversationURNs.slice(i, i + batchSize);
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

  const batchSize = 50;
  for (let i = 0; i < messageURNs.length; i += batchSize) {
    const batch = messageURNs.slice(i, i + batchSize);
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

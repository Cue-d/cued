/**
 * Twitter/X sync operations.
 * Handles syncing conversations and messages from Electron to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getOrCreateContact,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
  BATCH_SIZE,
  getOrCreateIntegration,
  incrementSyncCursorStat,
  upsertSyncCursor,
  clearIntegrationError,
  MAX_NEW_CONNECTION_ACTIONS,
  extractCompanyFromHeadline,
  logSyncError,
} from "./shared";

// ============================================================================
// Validators
// ============================================================================

export const twitterParticipantInput = v.object({
  userId: v.string(),
  screenName: v.string(),
  name: v.string(),
  profileImageUrl: v.optional(v.string()),
  isAdmin: v.boolean(),
  lastReadEventId: v.optional(v.string()),
});

export const twitterConversationInput = v.object({
  conversationId: v.string(),
  conversationType: v.union(v.literal("dm"), v.literal("group")),
  name: v.optional(v.string()),
  avatarImageUrl: v.optional(v.string()),
  sortTimestamp: v.optional(v.number()),
  participants: v.array(twitterParticipantInput),
});

export const twitterMessageInput = v.object({
  messageId: v.string(),
  conversationId: v.string(),
  text: v.string(),
  sentAt: v.number(),
  senderId: v.string(),
  senderScreenName: v.optional(v.string()),
  senderName: v.optional(v.string()),
  senderProfileImageUrl: v.optional(v.string()),
  requestId: v.optional(v.string()),
});

export const twitterConversationsBatchInput = v.object({
  conversations: v.array(twitterConversationInput),
  twitterUserId: v.optional(v.string()),
});

export const twitterMessagesBatchInput = v.object({
  messages: v.array(twitterMessageInput),
  twitterUserId: v.optional(v.string()),
});

// ============================================================================
// Types
// ============================================================================

export type TwitterParticipantInput = Infer<typeof twitterParticipantInput>;
export type TwitterConversationInput = Infer<typeof twitterConversationInput>;
export type TwitterMessageInput = Infer<typeof twitterMessageInput>;

// ============================================================================
// Sync implementation
// ============================================================================

export async function syncTwitterConversationsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversations: TwitterConversationInput[],
  twitterUserId?: string
) {
  const result = {
    conversationsCount: 0,
    newConversations: 0,
    updatedConversations: 0,
    participantsLinked: 0,
    errors: [] as string[],
  };

  const existingConversations = await batchFetchTwitterConversations(
    ctx,
    userId,
    conversations.map((conversation) => conversation.conversationId)
  );
  const conversationMap = new Map(
    existingConversations.map((conversation) => [conversation.platformConversationId, conversation])
  );

  for (const conversation of conversations) {
    try {
      const existing = conversationMap.get(conversation.conversationId);

      const participantContactIds: Id<"contacts">[] = [];
      const otherParticipantNames: string[] = [];

      for (const participant of conversation.participants) {
        const isSelf = twitterUserId ? participant.userId === twitterUserId : false;
        if (isSelf) {
          continue;
        }

        const handle = participant.screenName?.trim() || participant.userId;
        const displayName = participant.name?.trim() || `@${handle}`;

        const contact = await getOrCreateContact(
          ctx,
          userId,
          "twitter",
          buildTwitterHandles(handle, participant.userId),
          displayName
        );

        if (contact) {
          participantContactIds.push(contact.contactId);
          result.participantsLinked++;
        }

        if (displayName.length > 0) {
          otherParticipantNames.push(displayName);
        }
      }

      const derivedName =
        conversation.name?.trim() ||
        (conversation.conversationType === "dm"
          ? otherParticipantNames[0] ?? "Twitter Conversation"
          : otherParticipantNames.join(", ") || "Twitter Group");

      if (existing) {
        const patchData: {
          conversationType: "dm" | "group";
          participantContactIds: Id<"contacts">[];
          displayName: string;
          unreadCount: number;
          lastMessageAt?: number;
        } = {
          conversationType: conversation.conversationType,
          participantContactIds,
          displayName: derivedName,
          unreadCount: existing.unreadCount ?? 0,
        };

        if (conversation.sortTimestamp) {
          patchData.lastMessageAt = Math.max(existing.lastMessageAt ?? 0, conversation.sortTimestamp);
        }

        await ctx.db.patch(existing._id, patchData);
        result.updatedConversations++;
      } else {
        await ctx.db.insert("conversations", {
          userId,
          platform: "twitter",
          platformConversationId: conversation.conversationId,
          conversationType: conversation.conversationType,
          participantContactIds,
          unreadCount: 0,
          displayName: derivedName,
          lastMessageAt: conversation.sortTimestamp,
        });
        result.newConversations++;
      }

      result.conversationsCount++;
    } catch (error) {
      result.errors.push(logSyncError("Twitter", "sync conversation", conversation.conversationId, error));
    }
  }

  await clearIntegrationError(ctx, userId, "twitter");
  await upsertSyncCursor(ctx, userId, "twitter", {});

  return result;
}

export async function syncTwitterMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: TwitterMessageInput[],
  twitterUserId?: string
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

  // Build lookup maps for deduplication
  const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
  const existingConversations = await batchFetchTwitterConversations(ctx, userId, conversationIds);

  // Track conversation state: _id, lastMessageAt, unreadCount
  type ConvState = { _id: Id<"conversations">; lastMessageAt?: number; unreadCount: number };
  const conversationMap = new Map<string, ConvState>(
    existingConversations.map((c) => [
      c.platformConversationId,
      { _id: c._id, lastMessageAt: c.lastMessageAt, unreadCount: c.unreadCount ?? 0 },
    ])
  );

  const existingMessages = await batchFetchTwitterMessages(ctx, userId, messages.map((m) => m.messageId));
  const existingMessageIds = new Set(existingMessages.map((m) => m.platformMessageId));

  const incomingConversations = new Set<Id<"conversations">>();
  const outgoingConversations = new Set<Id<"conversations">>();
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  for (const message of messages) {
    try {
      if (existingMessageIds.has(message.messageId)) {
        result.skippedMessages++;
        continue;
      }

      let conv = conversationMap.get(message.conversationId);
      if (!conv) {
        const convId = await ctx.db.insert("conversations", {
          userId,
          platform: "twitter",
          platformConversationId: message.conversationId,
          conversationType: "dm",
          participantContactIds: [],
          unreadCount: 0,
        });
        conv = { _id: convId, unreadCount: 0 };
        conversationMap.set(message.conversationId, conv);
      }

      const isFromMe = twitterUserId ? message.senderId === twitterUserId : false;

      let senderContactId: Id<"contacts"> | undefined;
      if (!isFromMe) {
        const handle = message.senderScreenName?.trim() || message.senderId;
        const displayName = message.senderName?.trim() || `@${handle}`;

        const contact = await getOrCreateContact(
          ctx, userId, "twitter",
          buildTwitterHandles(handle, message.senderId),
          displayName
        );
        senderContactId = contact?.contactId;
      }

      await ctx.db.insert("messages", {
        userId,
        conversationId: conv._id,
        platform: "twitter",
        content: message.text,
        sentAt: message.sentAt,
        senderContactId,
        isFromMe,
        platformMessageId: message.messageId,
      });

      if (message.sentAt >= (conv.lastMessageAt ?? 0)) {
        const newUnread = isFromMe ? conv.unreadCount : conv.unreadCount + 1;
        await ctx.db.patch(conv._id, {
          lastMessageText: message.text,
          lastMessageAt: message.sentAt,
          unreadCount: newUnread,
        });
        conv.lastMessageAt = message.sentAt;
        conv.unreadCount = newUnread;
      }

      if (message.sentAt >= cutoff) {
        (isFromMe ? outgoingConversations : incomingConversations).add(conv._id);
      }

      existingMessageIds.add(message.messageId);
      result.newMessages++;
      result.messagesCount++;
    } catch (error) {
      result.errors.push(logSyncError("Twitter", "sync message", message.messageId, error));
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConversations, "twitter");
  await scheduleOutgoingMessageEvents(ctx, userId, outgoingConversations);

  await incrementSyncCursorStat(ctx, userId, "twitter", "totalMessagesSynced", result.newMessages);
  await clearIntegrationError(ctx, userId, "twitter");
  await upsertSyncCursor(ctx, userId, "twitter", {});

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

type TwitterHandle = { value: string; type: "twitter_user_id" | "twitter_handle" };

/** Build handle pairs for getOrCreateContact. userId is optional (contacts from scraping may not have it). */
function buildTwitterHandles(handle: string, userId?: string): TwitterHandle[] {
  const handles: TwitterHandle[] = [];
  if (userId) {
    handles.push({ value: userId, type: "twitter_user_id" });
  }
  handles.push({ value: handle, type: "twitter_handle" });
  return handles;
}

async function batchFetchTwitterConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationIds: string[]
): Promise<Doc<"conversations">[]> {
  const unique = [...new Set(conversationIds)];
  const results: Doc<"conversations">[] = [];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = await Promise.all(
      unique.slice(i, i + BATCH_SIZE).map((id) =>
        ctx.db
          .query("conversations")
          .withIndex("by_platform_conversation", (q) =>
            q.eq("userId", userId).eq("platform", "twitter").eq("platformConversationId", id)
          )
          .unique()
      )
    );
    results.push(...batch.filter((c): c is NonNullable<typeof c> => c !== null));
  }

  return results;
}

async function batchFetchTwitterMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageIds: string[]
): Promise<Doc<"messages">[]> {
  const unique = [...new Set(messageIds)];
  const results: Doc<"messages">[] = [];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = await Promise.all(
      unique.slice(i, i + BATCH_SIZE).map((id) =>
        ctx.db
          .query("messages")
          .withIndex("by_platform_message", (q) =>
            q.eq("userId", userId).eq("platform", "twitter").eq("platformMessageId", id)
          )
          .unique()
      )
    );
    results.push(...batch.filter((m): m is NonNullable<typeof m> => m !== null));
  }

  return results;
}

// ============================================================================
// Twitter Contacts Sync
// ============================================================================

export const twitterContactInput = v.object({
  name: v.string(),
  handle: v.string(),
  userId: v.optional(v.string()),
  bio: v.union(v.string(), v.null()),
});

export const twitterContactsBatchInput = v.object({
  contacts: v.array(twitterContactInput),
});

type TwitterContactInput = Infer<typeof twitterContactInput>;

function normalizeTwitterHandle(handle: string): string {
  return handle.toLowerCase().replace(/^@/, "").trim();
}

export async function syncTwitterContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  contacts: TwitterContactInput[]
) {
  const result = {
    totalContacts: contacts.length,
    newContacts: 0,
    updatedContacts: 0,
    actionsCreated: 0,
    errors: [] as string[],
    duplicatesSkipped: 0,
  };

  // Deduplicate within batch by normalized handle
  const seenHandles = new Set<string>();
  const deduped: TwitterContactInput[] = [];
  for (const contact of contacts) {
    const normalized = normalizeTwitterHandle(contact.handle);
    if (!normalized) continue;
    if (seenHandles.has(normalized)) {
      result.duplicatesSkipped++;
      continue;
    }
    seenHandles.add(normalized);
    deduped.push(contact);
  }

  const newContactsInfo: Array<{
    contactId: Id<"contacts">;
    bio: string | null;
    handle: string;
  }> = [];

  for (const contact of deduped) {
    try {
      const normalized = normalizeTwitterHandle(contact.handle);
      if (!normalized) continue;

      const company = extractCompanyFromHeadline(contact.bio);
      const contactResult = await getOrCreateContact(
        ctx,
        userId,
        "twitter",
        buildTwitterHandles(normalized, contact.userId),
        contact.name,
        company ? { company } : undefined
      );

      if (!contactResult) continue;

      if (contactResult.created) {
        result.newContacts++;
        newContactsInfo.push({
          contactId: contactResult.contactId,
          bio: contact.bio,
          handle: contact.handle,
        });
      } else {
        // Update company if missing on existing contact
        if (company) {
          const existingContact = await ctx.db.get(contactResult.contactId);
          if (existingContact && !existingContact.company) {
            await ctx.db.patch(contactResult.contactId, { company });
          }
        }
        result.updatedContacts++;
      }
    } catch (e) {
      result.errors.push(logSyncError("Twitter", "sync contact", contact.name, e));
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
      platform: "twitter",
      llmReason: info.bio ?? undefined,
      reason: `https://x.com/${info.handle}`,
      createdAt: now,
    });
    result.actionsCreated++;
  }

  if (result.actionsCreated > 0) {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        pendingActionCount: (user.pendingActionCount ?? 0) + result.actionsCreated,
      });
    }
  }

  await incrementSyncCursorStat(ctx, userId, "twitter", "totalContactsSynced", result.newContacts);
  await getOrCreateIntegration(ctx, userId, "twitter");
  await clearIntegrationError(ctx, userId, "twitter");

  return result;
}

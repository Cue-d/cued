/**
 * iMessage sync operations.
 * Handles syncing messages and contacts from macOS iMessage to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getPhoneVariants as getPhoneVariantsShared } from "@prm/shared";
import {
  handleInput,
  normalizeHandle,
  createPlaceholderContact,
  batchResolveHandles,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  SEVEN_DAYS_MS,
} from "./shared";

// ============================================================================
// Validators
// ============================================================================

const chatInput = v.object({
  id: v.number(),
  identifier: v.string(),
  displayName: v.union(v.string(), v.null()),
  isGroup: v.boolean(),
  participants: v.array(handleInput),
});

/** Validator for uploaded attachments (after Convex storage upload) */
const uploadedAttachmentInput = v.object({
  filename: v.string(),
  mimeType: v.string(),
  size: v.number(),
  storageId: v.id("_storage"),
  thumbnailStorageId: v.optional(v.id("_storage")),
});

const messageInput = v.object({
  id: v.number(),
  chatId: v.number(),
  text: v.union(v.string(), v.null()),
  timestamp: v.number(),
  isFromMe: v.boolean(),
  isRead: v.boolean(),
  readAt: v.union(v.number(), v.null()),
  hasAttachments: v.boolean(),
  attachments: v.optional(v.array(uploadedAttachmentInput)),
  sender: v.union(handleInput, v.null()),
});

export const syncBatchInput = v.object({
  cursor: v.number(),
  chats: v.array(chatInput),
  messages: v.array(messageInput),
  handles: v.array(handleInput),
});

// ============================================================================
// Types
// ============================================================================

type ChatInput = Infer<typeof chatInput>;
type MessageInput = Infer<typeof messageInput>;
export type BatchInput = Infer<typeof syncBatchInput>;

// ============================================================================
// iMessage Sync Implementation
// ============================================================================

/**
 * Internal sync logic shared by mutations.
 * OPTIMIZED: Uses batch lookups to eliminate N+1 queries.
 */
export async function syncMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  batch: BatchInput
) {
  const result = {
    cursor: batch.cursor,
    messagesCount: 0,
    chatsCount: 0,
    errors: [] as string[],
  };

  // OPTIMIZATION 1: Batch lookup existing conversations by platformConversationId
  const conversationIds = batch.chats.map((c) => String(c.id));
  const existingConversations = await batchFetchConversations(
    ctx,
    userId,
    conversationIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // OPTIMIZATION 2: Batch lookup existing messages by platformMessageId
  const messageIds = batch.messages.map((m) => String(m.id));
  const existingMessages = await batchFetchMessages(ctx, userId, messageIds);
  const existingMessageSet = new Set(existingMessages.map((m) => m.platformMessageId));

  // OPTIMIZATION 3: Batch lookup handles → contacts for all senders
  const uniqueHandles = new Set<string>();
  for (const msg of batch.messages) {
    if (!msg.isFromMe && msg.sender) {
      uniqueHandles.add(normalizeHandle(msg.sender.identifier));
    }
  }
  for (const chat of batch.chats) {
    for (const p of chat.participants) {
      uniqueHandles.add(normalizeHandle(p.identifier));
    }
  }
  const handleToContact = await batchResolveHandles(
    ctx,
    userId,
    [...uniqueHandles]
  );

  // Build chat ID lookup (iMessage chat.id -> Convex conversation._id)
  const chatIdMap = new Map<number, Id<"conversations">>();

  // Process chats - use existing or create new
  for (const chat of batch.chats) {
    try {
      const platformConversationId = String(chat.id);
      const existingId = conversationMap.get(platformConversationId);

      if (existingId) {
        chatIdMap.set(chat.id, existingId);
        // Update displayName for existing group chats if not set
        if (chat.isGroup && chat.displayName) {
          const existingConv = await ctx.db.get(existingId);
          if (existingConv && !existingConv.displayName) {
            await ctx.db.patch(existingId, { displayName: chat.displayName });
          }
        }
      } else {
        // Resolve participant handles to contacts from pre-fetched map
        const participantContactIds: Id<"contacts">[] = [];
        for (const participant of chat.participants) {
          const normalizedHandle = normalizeHandle(participant.identifier);
          let contactId = handleToContact.get(normalizedHandle);
          if (!contactId) {
            // Create placeholder contact
            contactId = await createPlaceholderContact(
              ctx,
              userId,
              participant.identifier
            );
            handleToContact.set(normalizedHandle, contactId);
          }
          participantContactIds.push(contactId);
        }

        const conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "imessage",
          platformConversationId,
          conversationType: chat.isGroup ? "group" : "dm",
          participantContactIds,
          unreadCount: 0,
          displayName: chat.isGroup ? (chat.displayName ?? undefined) : undefined,
        });
        chatIdMap.set(chat.id, conversationId);
      }
      result.chatsCount++;
    } catch (e) {
      result.errors.push(`Failed to sync chat ${chat.id}: ${e}`);
    }
  }

  // Process messages - bulk insert only new messages
  const conversationUpdates = new Map<
    Id<"conversations">,
    { text: string; timestamp: number }
  >();

  const messagesToInsert: Array<{
    userId: Id<"users">;
    conversationId: Id<"conversations">;
    platform: "imessage";
    content: string;
    sentAt: number;
    senderContactId: Id<"contacts"> | undefined;
    isFromMe: boolean;
    platformMessageId: string;
    attachments?: typeof batch.messages[number]["attachments"];
  }> = [];

  for (const message of batch.messages) {
    const platformMessageId = String(message.id);

    // Skip if already exists
    if (existingMessageSet.has(platformMessageId)) {
      continue;
    }

    const conversationId = chatIdMap.get(message.chatId);
    if (!conversationId) {
      result.errors.push(`No conversation found for chat ${message.chatId}`);
      continue;
    }

    // Resolve sender from pre-fetched map
    let senderContactId: Id<"contacts"> | undefined;
    if (!message.isFromMe && message.sender) {
      const normalizedHandle = normalizeHandle(message.sender.identifier);
      senderContactId = handleToContact.get(normalizedHandle);
      if (!senderContactId) {
        // Create placeholder contact
        senderContactId = await createPlaceholderContact(
          ctx,
          userId,
          message.sender.identifier
        );
        handleToContact.set(normalizedHandle, senderContactId);
      }
    }

    messagesToInsert.push({
      userId,
      conversationId,
      platform: "imessage",
      content: message.text ?? "",
      sentAt: message.timestamp * 1000,
      senderContactId,
      isFromMe: message.isFromMe,
      platformMessageId,
      attachments:
        message.attachments && message.attachments.length > 0
          ? message.attachments
          : undefined,
    });

    // Track latest message per conversation for lastMessage update
    const messageTimestampMs = message.timestamp * 1000;
    const existing = conversationUpdates.get(conversationId);
    if (!existing || messageTimestampMs > existing.timestamp) {
      conversationUpdates.set(conversationId, {
        text: message.text ?? "",
        timestamp: messageTimestampMs,
      });
    }
  }

  // Bulk insert messages
  for (const msg of messagesToInsert) {
    await ctx.db.insert("messages", msg);
    result.messagesCount++;
  }

  // Update lastMessage fields on conversations
  for (const [conversationId, update] of conversationUpdates) {
    await ctx.db.patch(conversationId, {
      lastMessageText: update.text,
      lastMessageAt: update.timestamp,
    });
  }

  // Schedule action analysis for new messages (event-driven)
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();
  const outgoingConvos = new Set<Id<"conversations">>();

  for (const msg of messagesToInsert) {
    if (msg.sentAt < cutoff) continue;
    if (msg.isFromMe) {
      outgoingConvos.add(msg.conversationId);
    } else {
      incomingConvos.add(msg.conversationId);
    }
  }

  await scheduleIncomingMessageEvents(ctx, userId, incomingConvos, "imessage");
  await scheduleOutgoingMessageEvents(ctx, userId, outgoingConvos);

  return result;
}

// ============================================================================
// Batch Fetch Helpers
// ============================================================================

/**
 * Batch fetch existing conversations by platformConversationId.
 */
async function batchFetchConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  platformConversationIds: string[]
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  // Fetch in parallel batches of 50 to stay under Convex 4096 read limit
  const batchSize = 50;
  for (let i = 0; i < platformConversationIds.length; i += batchSize) {
    const batch = platformConversationIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "imessage")
            .eq("platformConversationId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((c): c is Doc<"conversations"> => c !== null));
  }

  return results;
}

/**
 * Batch fetch existing messages by platformMessageId.
 */
async function batchFetchMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  platformMessageIds: string[]
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  // Fetch in parallel batches of 50 to stay under Convex 4096 read limit
  const batchSize = 50;
  for (let i = 0; i < platformMessageIds.length; i += batchSize) {
    const batch = platformMessageIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "imessage")
            .eq("platformMessageId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((m): m is Doc<"messages"> => m !== null));
  }

  return results;
}

// ============================================================================
// Contacts Sync
// ============================================================================

/** Validator for contact input from Electron */
export const contactInput = v.object({
  displayName: v.string(),
  company: v.union(v.string(), v.null()),
  phoneNumbers: v.array(v.string()),
  emails: v.array(v.string()),
});

export type ContactInput = Infer<typeof contactInput>;

/**
 * Internal sync logic for contacts.
 */
export async function syncContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  contacts: ContactInput[]
) {
  const result = {
    contactsCount: 0,
    handlesCount: 0,
    updatedCount: 0,
    errors: [] as string[],
  };

  // Track contacts that need merge candidate search (new or got new handles)
  const contactsToCheckForMerges: Id<"contacts">[] = [];

  for (const contact of contacts) {
    try {
      const syncResult = await upsertContactWithHandles(ctx, userId, contact);
      if (syncResult.isNew) {
        result.contactsCount++;
        contactsToCheckForMerges.push(syncResult.contactId);
      } else {
        result.updatedCount++;
        // Also check for merges if new handles were added
        if (syncResult.handlesAdded > 0) {
          contactsToCheckForMerges.push(syncResult.contactId);
        }
      }
      result.handlesCount += syncResult.handlesAdded;
    } catch (e) {
      result.errors.push(`Failed to sync contact ${contact.displayName}: ${e}`);
    }
  }

  // Schedule merge candidate search for contacts with new/updated handles
  for (const contactId of contactsToCheckForMerges) {
    await ctx.scheduler.runAfter(
      0,
      internal.contactResolution.findMergeCandidatesForContact,
      { userId, contactId }
    );
  }

  return result;
}

/**
 * Find an existing contact by checking all handle variants.
 */
export async function findContactByHandle(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: { value: string; type: "phone" | "email" }
): Promise<Id<"contacts"> | null> {
  const variants =
    handle.type === "phone"
      ? getPhoneVariantsShared(handle.value)
      : [handle.value];

  for (const variant of variants) {
    const existing = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", variant)
      )
      .unique();

    if (existing) {
      return existing.contactId;
    }
  }
  return null;
}

/**
 * Upsert a contact by finding existing contact via any of its handles,
 * or creating a new one if no match found.
 */
async function upsertContactWithHandles(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: ContactInput
): Promise<{ isNew: boolean; handlesAdded: number; contactId: Id<"contacts"> }> {
  // Collect all normalized handles
  const handles = [
    ...contact.phoneNumbers.map((p) => ({
      value: normalizeHandle(p),
      type: "phone" as const,
    })),
    ...contact.emails.map((e) => ({
      value: normalizeHandle(e),
      type: "email" as const,
    })),
  ];

  // Find existing contact by any handle
  let contactId: Id<"contacts"> | null = null;
  for (const handle of handles) {
    contactId = await findContactByHandle(ctx, userId, handle);
    if (contactId) break;
  }

  const isNew = contactId === null;
  const contactData = {
    displayName: contact.displayName,
    company: contact.company ?? undefined,
  };

  if (contactId) {
    await ctx.db.patch(contactId, contactData);
  } else {
    contactId = await ctx.db.insert("contacts", { userId, ...contactData });
  }

  // Add missing handles or update mislinked ones
  let handlesAdded = 0;
  for (const handle of handles) {
    const existing = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle.value)
      )
      .unique();

    if (!existing) {
      await ctx.db.insert("contactHandles", {
        userId,
        contactId,
        handleType: handle.type,
        handle: handle.value,
        platform: "imessage",
      });
      handlesAdded++;
    } else if (existing.contactId !== contactId) {
      await ctx.db.patch(existing._id, { contactId });
    }
  }

  return { isNew, handlesAdded, contactId };
}

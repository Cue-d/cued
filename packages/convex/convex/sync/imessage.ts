/**
 * iMessage sync operations.
 * Handles syncing messages and contacts from macOS iMessage to Convex.
 */

import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getPhoneVariants as getPhoneVariantsShared } from "@cued/shared";
import {
  handleInput,
  normalizeHandle,
  getOrCreateContact,
  batchResolveHandles,
  scheduleIncomingMessageEvents,
  scheduleOutgoingMessageEvents,
  shouldUpdateDisplayName,
  SEVEN_DAYS_MS,
  logSyncError,
  resolveMessageQueueBridge,
} from "./shared";
import { batchFetchConversations, batchFetchMessages } from "./batchUtils";
import { scheduleContactMergeCheck } from "../lib/contactMergeScheduling";

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

const messageInput = v.object({
  id: v.number(),
  chatId: v.number(),
  text: v.union(v.string(), v.null()),
  timestamp: v.number(),
  isFromMe: v.boolean(),
  isRead: v.boolean(),
  readAt: v.union(v.number(), v.null()),
  hasAttachments: v.boolean(),
  sender: v.union(handleInput, v.null()),
  // Allow attachments field from Electron but don't store it (not in schema)
  attachments: v.optional(v.array(v.any())),
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

function isUrnIdentifier(identifier: string): boolean {
  return identifier.trim().toLowerCase().startsWith("urn:");
}

function isBusinessUrn(identifier: string): boolean {
  return identifier.trim().toLowerCase().startsWith("urn:biz:");
}

function getHandleType(identifier: string): "phone" | "email" | "urn" {
  if (isUrnIdentifier(identifier)) return "urn";
  if (identifier.includes("@")) return "email";
  return "phone";
}


function isBusinessChat(chat: ChatInput): boolean {
  if (isBusinessUrn(chat.identifier)) return true;
  return chat.participants.some((p) => isBusinessUrn(p.identifier));
}

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
  batch: BatchInput,
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
    "imessage",
    conversationIds,
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id]),
  );
  // Track existing lastMessageAt to avoid overwriting with older timestamps (important for DESC sync)
  const existingLastMessageAt = new Map(
    existingConversations
      .filter((c) => c.lastMessageAt !== undefined)
      .map((c) => [c._id, c.lastMessageAt!]),
  );

  // OPTIMIZATION 2: Batch lookup existing messages by platformMessageId
  const messageIds = batch.messages.map((m) => String(m.id));
  const existingMessages = await batchFetchMessages(
    ctx,
    userId,
    "imessage",
    messageIds,
  );
  const existingMessageSet = new Set(
    existingMessages.map((m) => m.platformMessageId),
  );

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
  const handleToContact = await batchResolveHandles(ctx, userId, [
    ...uniqueHandles,
  ]);
  const chatById = new Map(batch.chats.map((chat) => [chat.id, chat]));

  const resolveContactByIdentifier = async (
    identifier: string,
    displayName?: string,
  ): Promise<Id<"contacts"> | undefined> => {
    const normalizedHandle = normalizeHandle(identifier);
    let contactId = handleToContact.get(normalizedHandle);

    if (!contactId) {
      const result = await getOrCreateContact(
        ctx,
        userId,
        "imessage",
        [{ value: identifier, type: getHandleType(identifier) }],
        displayName,
      );
      if (result) {
        contactId = result.contactId;
        handleToContact.set(normalizedHandle, contactId);
      }
      return contactId;
    }

    if (displayName) {
      const existingContact = await ctx.db.get(contactId);
      if (
        existingContact &&
        shouldUpdateDisplayName(
          existingContact.displayName,
          displayName,
          normalizedHandle,
        )
      ) {
        await ctx.db.patch(contactId, { displayName });
      }
    }

    return contactId;
  };

  // Build chat ID lookup (iMessage chat.id -> Convex conversation._id)
  const chatIdMap = new Map<number, Id<"conversations">>();

  // Process chats - use existing or create new
  for (const chat of batch.chats) {
    try {
      const platformConversationId = String(chat.id);
      const existingId = conversationMap.get(platformConversationId);
      const businessChat = isBusinessChat(chat);
      const participantContactIds: Id<"contacts">[] = [];

      for (const participant of chat.participants) {
        const contactId = await resolveContactByIdentifier(
          participant.identifier,
          isBusinessUrn(participant.identifier)
            ? (chat.displayName ?? undefined)
            : undefined,
        );
        if (contactId) {
          participantContactIds.push(contactId);
        }
      }

      if (existingId) {
        chatIdMap.set(chat.id, existingId);
        const existingConv = await ctx.db.get(existingId);
        if (existingConv) {
          const updates: {
            displayName?: string;
            participantContactIds?: Id<"contacts">[];
          } = {};

          // Update displayName for existing group chats and business DMs if missing.
          if ((chat.isGroup || businessChat) && chat.displayName && !existingConv.displayName) {
            updates.displayName = chat.displayName;
          }

          // Keep business chat participants aligned to corrected URN-backed contacts.
          if (businessChat && participantContactIds.length > 0) {
            const isSameParticipantSet =
              existingConv.participantContactIds.length ===
                participantContactIds.length &&
              participantContactIds.every((id) =>
                existingConv.participantContactIds.includes(id),
              );
            if (!isSameParticipantSet) {
              updates.participantContactIds = participantContactIds;
            }
          }

          if (Object.keys(updates).length > 0) {
            await ctx.db.patch(existingId, updates);
          }
        }
      } else {
        // For group chats without explicit name, concatenate participant names
        let conversationDisplayName: string | undefined;
        if (chat.isGroup) {
          if (chat.displayName) {
            conversationDisplayName = chat.displayName;
          } else {
            // Fetch participant contacts to build display name
            const participantContacts = await Promise.all(
              participantContactIds.map((id) => ctx.db.get(id)),
            );
            const names = participantContacts
              .filter((c): c is NonNullable<typeof c> => c !== null)
              .map((c) => c.displayName);
            if (names.length > 0) {
              conversationDisplayName = names.join(", ");
            }
          }
        } else if (businessChat && chat.displayName) {
          conversationDisplayName = chat.displayName;
        }

        const conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "imessage",
          platformConversationId,
          conversationType: chat.isGroup ? "group" : "dm",
          participantContactIds,
          unreadCount: 0,
          displayName: conversationDisplayName,
        });
        chatIdMap.set(chat.id, conversationId);
      }
      result.chatsCount++;
    } catch (e) {
      result.errors.push(
        logSyncError("iMessage", "sync chat", String(chat.id), e),
      );
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
  }> = [];

  for (const message of batch.messages) {
    const platformMessageId = String(message.id);

    // Skip if already exists
    if (existingMessageSet.has(platformMessageId)) {
      continue;
    }

    const conversationId = chatIdMap.get(message.chatId);
    if (!conversationId) {
      result.errors.push(
        logSyncError(
          "iMessage",
          "find conversation for message",
          String(message.chatId),
          "conversation not found",
        ),
      );
      continue;
    }

    // Resolve sender from pre-fetched map
    let senderContactId: Id<"contacts"> | undefined;
    if (!message.isFromMe && message.sender) {
      const chat = chatById.get(message.chatId);
      senderContactId = await resolveContactByIdentifier(
        message.sender.identifier,
        chat && isBusinessUrn(message.sender.identifier)
          ? (chat.displayName ?? undefined)
          : undefined,
      );
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

  // Recompute conversation updates from inserted timestamps after queue bridge.
  conversationUpdates.clear();
  const analysisCandidates: Array<{
    conversationId: Id<"conversations">;
    isFromMe: boolean;
    sentAt: number;
  }> = [];

  // Bulk insert messages (with delivery status for sent messages)
  for (const msg of messagesToInsert) {
    const bridge = msg.isFromMe
      ? await resolveMessageQueueBridge(
          ctx,
          userId,
          msg.conversationId,
          msg.content,
          msg.isFromMe,
          msg.sentAt
        )
      : { status: undefined, sentAt: undefined };
    const finalSentAt = bridge.sentAt ?? msg.sentAt;

    await ctx.db.insert("messages", {
      ...msg,
      sentAt: finalSentAt,
      status: bridge.status,
    });
    result.messagesCount++;
    analysisCandidates.push({
      conversationId: msg.conversationId,
      isFromMe: msg.isFromMe,
      sentAt: finalSentAt,
    });

    const existing = conversationUpdates.get(msg.conversationId);
    if (!existing || finalSentAt > existing.timestamp) {
      conversationUpdates.set(msg.conversationId, {
        text: msg.content,
        timestamp: finalSentAt,
      });
    }
  }

  // Update lastMessage fields on conversations (only if newer than existing)
  // This prevents DESC sync batches from overwriting with older timestamps
  for (const [conversationId, update] of conversationUpdates) {
    const existingTimestamp = existingLastMessageAt.get(conversationId);
    if (
      existingTimestamp === undefined ||
      update.timestamp > existingTimestamp
    ) {
      await ctx.db.patch(conversationId, {
        lastMessageText: update.text,
        lastMessageAt: update.timestamp,
      });
      // Update tracking map for subsequent batches within same sync cycle
      existingLastMessageAt.set(conversationId, update.timestamp);
    }
  }

  // Schedule action analysis for new messages (event-driven)
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const incomingConvos = new Set<Id<"conversations">>();
  const outgoingConvos = new Set<Id<"conversations">>();

  for (const msg of analysisCandidates) {
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
  contacts: ContactInput[],
  platform: "imessage" | "signal" = "imessage",
) {
  const result = {
    contactsCount: 0,
    handlesCount: 0,
    updatedCount: 0,
    errors: [] as string[],
  };

  for (const contact of contacts) {
    try {
      const syncResult = await upsertContactWithHandles(
        ctx,
        userId,
        contact,
        platform,
      );
      if (syncResult.skipped) continue;
      if (syncResult.isNew) {
        result.contactsCount++;
      } else {
        result.updatedCount++;
      }
      result.handlesCount += syncResult.handlesAdded;
    } catch (e) {
      result.errors.push(
        logSyncError(platform, "sync contact", contact.displayName, e),
      );
    }
  }

  return result;
}

/**
 * Find an existing contact by checking all handle variants.
 */
export async function findContactByHandle(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: { value: string; type: "phone" | "email" },
): Promise<Id<"contacts"> | null> {
  const variants =
    handle.type === "phone"
      ? getPhoneVariantsShared(handle.value)
      : [handle.value];

  for (const variant of variants) {
    const existing = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", variant),
      )
      .first();

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
  contact: ContactInput,
  platform: "imessage" | "signal" = "imessage",
): Promise<
  | { skipped: true }
  | { skipped: false; isNew: boolean; handlesAdded: number; contactId: Id<"contacts"> }
> {
  // Collect all normalized handles, filtering out empty values
  const handles = [
    ...contact.phoneNumbers.map((p) => ({
      value: normalizeHandle(p),
      type: "phone" as const,
    })),
    ...contact.emails.map((e) => ({
      value: normalizeHandle(e),
      type: "email" as const,
    })),
  ].filter((h) => h.value.trim() !== "");

  // Skip contacts with no valid handles — without handles we can't
  // deduplicate across syncs, which causes phantom duplicates every cycle.
  if (handles.length === 0) {
    return { skipped: true };
  }

  const hasValidDisplayName = contact.displayName.trim() !== "";

  // Find existing contact by any handle
  let contactId: Id<"contacts"> | null = null;
  for (const handle of handles) {
    contactId = await findContactByHandle(ctx, userId, handle);
    if (contactId) break;
  }

  const isNew = contactId === null;

  // Use displayName if provided, otherwise use first handle as placeholder
  const displayName = hasValidDisplayName
    ? contact.displayName
    : (handles[0]?.value ?? "");

  const contactData = {
    displayName,
    company: contact.company ?? undefined,
  };

  let displayNameUpdated = false;
  if (contactId) {
    const existing = await ctx.db.get(contactId);
    const primaryHandle = handles[0]?.value ?? "";
    if (
      existing &&
      shouldUpdateDisplayName(existing.displayName, displayName, primaryHandle)
    ) {
      await ctx.db.patch(contactId, { displayName });
      displayNameUpdated = true;
    }
    if (contactData.company) {
      await ctx.db.patch(contactId, { company: contactData.company });
    }
  } else {
    contactId = await ctx.db.insert("contacts", { userId, ...contactData });
  }

  // Add missing handles or update mislinked ones
  let handlesAdded = 0;
  let handlesRelinked = false;
  for (const handle of handles) {
    const existingHandles = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle.value),
      )
      .collect();

    const existingForPlatform = existingHandles.find(
      (h) => h.platform === platform,
    );
    const existingAny = existingHandles[0];

    if (!existingAny) {
      // No handle exists at all — create it
      await ctx.db.insert("contactHandles", {
        userId,
        contactId,
        handleType: handle.type,
        handle: handle.value,
        platform,
      });
      handlesAdded++;
    } else if (!existingForPlatform) {
      // Handle exists for another platform — also create one for this platform
      // so the UI knows this contact is reachable on this platform
      await ctx.db.insert("contactHandles", {
        userId,
        contactId,
        handleType: handle.type,
        handle: handle.value,
        platform,
      });
      handlesAdded++;
      // Fix mislinked handles
      if (existingAny.contactId !== contactId) {
        await ctx.db.patch(existingAny._id, { contactId });
        handlesRelinked = true;
      }
    } else if (existingForPlatform.contactId !== contactId) {
      await ctx.db.patch(existingForPlatform._id, { contactId });
      handlesRelinked = true;
    }
  }

  if (isNew || displayNameUpdated || handlesAdded > 0 || handlesRelinked) {
    await scheduleContactMergeCheck(ctx, userId, contactId);
  }

  return { skipped: false as const, isNew, handlesAdded, contactId };
}

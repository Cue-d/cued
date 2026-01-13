import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { platformValidator } from "./schema";
import {
  normalizePhone,
  getPhoneVariants as getPhoneVariantsShared,
} from "@prm/shared";

// Convex validators matching @prm/integrations SyncBatch structure
const handleInput = v.object({
  id: v.number(),
  identifier: v.string(),
  service: v.string(),
});

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
});

const syncBatchInput = v.object({
  cursor: v.number(),
  chats: v.array(chatInput),
  messages: v.array(messageInput),
  handles: v.array(handleInput),
});

// Derive TypeScript types from validators
type ChatInput = Infer<typeof chatInput>;
type MessageInput = Infer<typeof messageInput>;
type BatchInput = Infer<typeof syncBatchInput>;

/**
 * Sync a batch of iMessage data from Electron to Convex.
 *
 * This mutation:
 * 1. Upserts conversations by platformConversationId
 * 2. Upserts messages by platformMessageId (dedup)
 * 3. Resolves sender handles to contact IDs
 * 4. Updates conversation lastMessage fields
 */
export const syncMessages = mutation({
  args: {
    batch: syncBatchInput,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync messages");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncMessagesInternal(ctx, user._id, args.batch);
  },
});

/**
 * Internal sync logic shared by mutations.
 */
async function syncMessagesInternal(
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

  // Build chat ID lookup (iMessage chat.id -> Convex conversation._id)
  const chatIdMap = new Map<number, Id<"conversations">>();

  // Process chats first (conversations must exist before messages)
  for (const chat of batch.chats) {
    try {
      const conversationId = await upsertConversation(ctx, userId, chat);
      chatIdMap.set(chat.id, conversationId);
      result.chatsCount++;
    } catch (e) {
      result.errors.push(`Failed to sync chat ${chat.id}: ${e}`);
    }
  }

  // Process messages
  const conversationUpdates = new Map<
    Id<"conversations">,
    { text: string; timestamp: number }
  >();

  for (const message of batch.messages) {
    try {
      const conversationId = chatIdMap.get(message.chatId);
      if (!conversationId) {
        result.errors.push(`No conversation found for chat ${message.chatId}`);
        continue;
      }

      // Resolve sender to contact ID
      let senderContactId: Id<"contacts"> | undefined;
      if (!message.isFromMe && message.sender) {
        senderContactId = await resolveHandleToContact(
          ctx,
          userId,
          message.sender.identifier
        );
      }

      await upsertMessage(
        ctx,
        userId,
        conversationId,
        message,
        senderContactId
      );
      result.messagesCount++;

      // Track latest message per conversation for lastMessage update
      const messageTimestampMs = message.timestamp * 1000;
      const existing = conversationUpdates.get(conversationId);
      if (!existing || messageTimestampMs > existing.timestamp) {
        conversationUpdates.set(conversationId, {
          text: message.text ?? "",
          timestamp: messageTimestampMs,
        });
      }
    } catch (e) {
      result.errors.push(`Failed to sync message ${message.id}: ${e}`);
    }
  }

  // Update lastMessage fields on conversations
  for (const [conversationId, update] of conversationUpdates) {
    await ctx.db.patch(conversationId, {
      lastMessageText: update.text,
      lastMessageAt: update.timestamp,
    });
  }

  return result;
}

/**
 * Get existing user or create a new one from auth identity.
 */
async function getOrCreateUser(
  ctx: MutationCtx,
  identity: { subject: string; email?: string; name?: string }
): Promise<Doc<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_workos_id", (q) => q.eq("workosUserId", identity.subject))
    .unique();

  if (existing) {
    return existing;
  }

  const userId = await ctx.db.insert("users", {
    workosUserId: identity.subject,
    email: identity.email ?? "",
    name: identity.name,
  });

  return (await ctx.db.get(userId))!;
}

/**
 * Upsert a conversation from iMessage chat data.
 */
async function upsertConversation(
  ctx: MutationCtx,
  userId: Id<"users">,
  chat: ChatInput
): Promise<Id<"conversations">> {
  const platformConversationId = String(chat.id);

  const existing = await ctx.db
    .query("conversations")
    .withIndex("by_platform_conversation", (q) =>
      q
        .eq("userId", userId)
        .eq("platform", "imessage")
        .eq("platformConversationId", platformConversationId)
    )
    .unique();

  if (existing) {
    return existing._id;
  }

  // Resolve participant handles to contacts
  const participantContactIds: Id<"contacts">[] = [];
  for (const participant of chat.participants) {
    const contactId = await resolveHandleToContact(
      ctx,
      userId,
      participant.identifier
    );
    if (contactId) {
      participantContactIds.push(contactId);
    }
  }

  return ctx.db.insert("conversations", {
    userId,
    platform: "imessage",
    platformConversationId,
    conversationType: chat.isGroup ? "group" : "dm",
    participantContactIds,
    unreadCount: 0,
  });
}

/**
 * Resolve an iMessage handle (phone/email) to a contact ID.
 * Creates a placeholder contact if one doesn't exist.
 */
async function resolveHandleToContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: string
): Promise<Id<"contacts"> | undefined> {
  const normalizedHandle = normalizeHandle(handle);

  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", normalizedHandle)
    )
    .unique();

  if (existingHandle) {
    return existingHandle.contactId;
  }

  // Create placeholder contact (can be enriched later from Contacts.app)
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: handle,
  });

  const handleType = handle.includes("@") ? "email" : "phone";
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType,
    handle: normalizedHandle,
    platform: "imessage",
  });

  return contactId;
}

/**
 * Upsert a message by platformMessageId (ROWID).
 */
async function upsertMessage(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  message: MessageInput,
  senderContactId?: Id<"contacts">
): Promise<void> {
  const platformMessageId = String(message.id);

  // Check if message exists using indexed lookup (O(1) instead of scanning all messages)
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_platform_message", (q) =>
      q
        .eq("userId", userId)
        .eq("platform", "imessage")
        .eq("platformMessageId", platformMessageId)
    )
    .unique();

  if (existing) {
    return;
  }

  await ctx.db.insert("messages", {
    userId,
    conversationId,
    platform: "imessage",
    content: message.text ?? "",
    sentAt: message.timestamp * 1000,
    senderContactId,
    isFromMe: message.isFromMe,
    platformMessageId,
  });
}

/**
 * Normalize a handle for consistent lookups.
 * - Phone numbers: use normalizePhone from @prm/shared
 * - Emails: lowercase
 */
function normalizeHandle(handle: string): string {
  if (handle.includes("@")) {
    return handle.toLowerCase();
  }
  return normalizePhone(handle);
}

// Validator for contact input from Electron
const contactInput = v.object({
  displayName: v.string(),
  company: v.union(v.string(), v.null()),
  phoneNumbers: v.array(v.string()),
  emails: v.array(v.string()),
});

type ContactInput = Infer<typeof contactInput>;

/**
 * Sync contacts from macOS Contacts.app to Convex.
 *
 * This mutation:
 * 1. Upserts contacts by normalized handle (finds existing by any phone/email)
 * 2. Updates displayName and company from Contacts.app data
 * 3. Links all handles to the contact record
 * 4. Handles phone number variants for US/Canada numbers
 */
export const syncContacts = mutation({
  args: {
    contacts: v.array(contactInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncContactsInternal(ctx, user._id, args.contacts);
  },
});

/**
 * Internal sync logic for contacts.
 */
async function syncContactsInternal(
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

  for (const contact of contacts) {
    try {
      const syncResult = await upsertContactWithHandles(ctx, userId, contact);
      if (syncResult.isNew) {
        result.contactsCount++;
      } else {
        result.updatedCount++;
      }
      result.handlesCount += syncResult.handlesAdded;
    } catch (e) {
      result.errors.push(`Failed to sync contact ${contact.displayName}: ${e}`);
    }
  }

  return result;
}

/**
 * Find an existing contact by checking all handle variants.
 */
async function findContactByHandle(
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
): Promise<{ isNew: boolean; handlesAdded: number }> {
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

  return { isNew, handlesAdded };
}

// ============================================================================
// Sync Cursor Management
// ============================================================================

/**
 * Get the sync cursor for a platform from the integrations table.
 */
export const getSyncCursor = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    return {
      cursor: integration?.syncState.lastSyncCursor ?? "0",
      lastSyncAt: integration?.syncState.lastSyncAt ?? null,
    };
  },
});

/**
 * Update the sync cursor for a platform after successful sync.
 */
export const updateSyncCursor = mutation({
  args: {
    platform: platformValidator,
    cursor: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    const integration = await getOrCreateIntegration(
      ctx,
      user._id,
      args.platform
    );

    await ctx.db.patch(integration._id, {
      syncState: {
        ...integration.syncState,
        lastSyncCursor: args.cursor,
        lastSyncAt: Date.now(),
        lastError: undefined,
      },
    });

    return { success: true };
  },
});

/**
 * Find user by WorkOS ID (for queries).
 */
function findUserByWorkosId(
  ctx: QueryCtx,
  workosUserId: string
): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_workos_id", (q) => q.eq("workosUserId", workosUserId))
    .unique();
}

/**
 * Find integration by user and platform.
 */
function findIntegration(
  ctx: QueryCtx,
  userId: Id<"users">,
  platform: "imessage" | "gmail" | "slack"
): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_user_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform)
    )
    .unique();
}

/**
 * Get or create an integration record for a user+platform.
 */
async function getOrCreateIntegration(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: "imessage" | "gmail" | "slack"
): Promise<Doc<"integrations">> {
  const existing = await findIntegration(ctx, userId, platform);
  if (existing) return existing;

  const integrationId = await ctx.db.insert("integrations", {
    userId,
    platform,
    syncState: {
      isConnected: true,
      lastSyncCursor: "0",
    },
  });

  return (await ctx.db.get(integrationId))!;
}

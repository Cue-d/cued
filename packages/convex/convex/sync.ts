import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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

// Validator for uploaded attachments (after Convex storage upload)
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
  // Uploaded attachments with Convex storage IDs
  attachments: v.optional(v.array(uploadedAttachmentInput)),
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
 * OPTIMIZED: Uses batch lookups to eliminate N+1 queries.
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

  return result;
}

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

/**
 * Batch resolve handles to contact IDs.
 */
async function batchResolveHandles(
  ctx: MutationCtx,
  userId: Id<"users">,
  handles: string[]
): Promise<Map<string, Id<"contacts">>> {
  const handleToContact = new Map<string, Id<"contacts">>();

  // Fetch in parallel batches of 50 to stay under Convex 4096 read limit
  const batchSize = 50;
  for (let i = 0; i < handles.length; i += batchSize) {
    const batch = handles.slice(i, i + batchSize);
    const promises = batch.map((handle) =>
      ctx.db
        .query("contactHandles")
        .withIndex("by_user_handle", (q) =>
          q.eq("userId", userId).eq("handle", handle)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);

    for (let j = 0; j < batch.length; j++) {
      const result = batchResults[j];
      if (result) {
        handleToContact.set(batch[j], result.contactId);
      }
    }
  }

  return handleToContact;
}

/**
 * Create a placeholder contact with handle.
 */
async function createPlaceholderContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  handle: string
): Promise<Id<"contacts">> {
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: handle,
  });

  const normalizedHandle = normalizeHandle(handle);
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

// Current sync version - increment when schema changes require full re-sync
export const CURRENT_SYNC_VERSION = 1;

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
 * Get full sync state for a platform, including metadata for recovery decisions.
 */
export const getSyncState = query({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await findUserByWorkosId(ctx, identity.subject);
    if (!user) return null;

    const integration = await findIntegration(ctx, user._id, args.platform);
    if (!integration) return null;

    return {
      cursor: integration.syncState.lastSyncCursor ?? "0",
      lastSyncAt: integration.syncState.lastSyncAt ?? null,
      totalMessagesSynced: integration.syncState.totalMessagesSynced ?? 0,
      totalContactsSynced: integration.syncState.totalContactsSynced ?? 0,
      syncVersion: integration.syncState.syncVersion ?? 0,
      isConnected: integration.syncState.isConnected,
      // Task 2.7c: Contacts sync state
      lastContactsSyncAt: integration.syncState.lastContactsSyncAt ?? null,
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
 * Update full sync metadata after successful sync.
 * Used for tracking sync progress and detecting recovery scenarios.
 */
export const updateSyncMetadata = mutation({
  args: {
    platform: platformValidator,
    cursor: v.string(),
    totalMessagesSynced: v.optional(v.number()),
    totalContactsSynced: v.optional(v.number()),
    syncVersion: v.optional(v.number()),
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
        totalMessagesSynced:
          args.totalMessagesSynced ?? integration.syncState.totalMessagesSynced,
        totalContactsSynced:
          args.totalContactsSynced ?? integration.syncState.totalContactsSynced,
        syncVersion: args.syncVersion ?? integration.syncState.syncVersion,
      },
    });

    return { success: true };
  },
});

/**
 * Reset sync state to trigger full re-sync.
 * Clears cursor and message count so recovery flow triggers full sync.
 */
export const resetSyncState = mutation({
  args: {
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated");
    }

    const user = await getOrCreateUser(ctx, identity);
    const integration = await findIntegration(ctx, user._id, args.platform);

    if (integration) {
      await ctx.db.patch(integration._id, {
        syncState: {
          isConnected: true,
          lastSyncCursor: "0",
          lastSyncAt: undefined,
          lastError: undefined,
          totalMessagesSynced: 0,
          totalContactsSynced: 0,
          syncVersion: CURRENT_SYNC_VERSION,
          // Task 2.7c: Reset contacts sync state
          lastContactsSyncAt: undefined,
        },
      });
    }

    return { success: true };
  },
});

/**
 * Update contacts sync state after successful contacts sync.
 * Task 2.7c: Stores lastContactsSyncAt and totalContactsSynced for recovery.
 */
export const updateContactsSyncState = mutation({
  args: {
    platform: platformValidator,
    contactsCount: v.number(),
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
        totalContactsSynced: args.contactsCount,
        lastContactsSyncAt: Date.now(),
        lastError: undefined,
      },
    });

    return { success: true };
  },
});

/**
 * Find user by WorkOS ID.
 */
function findUserByWorkosId(
  ctx: QueryCtx | MutationCtx,
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
  platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter"
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
  platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter"
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

// ============================================================================
// Gmail Message Sync
// ============================================================================

// Validator for Gmail email input (from Nango sync)
const gmailEmailInput = v.object({
  id: v.string(), // Gmail message ID
  sender: v.string(), // From header (e.g., "John Doe <john@example.com>")
  recipients: v.optional(v.string()), // To header
  date: v.string(), // ISO date string
  subject: v.string(),
  body: v.optional(v.string()),
  attachments: v.array(
    v.object({
      filename: v.string(),
      mimeType: v.string(),
      size: v.number(),
      attachmentId: v.string(),
    })
  ),
  threadId: v.string(), // Gmail thread ID
});

type GmailEmailInput = Infer<typeof gmailEmailInput>;

/**
 * Check if an email is likely a newsletter or automated message.
 * Used to filter out emails that shouldn't create memories.
 */
function isNewsletterOrAutomated(email: GmailEmailInput): boolean {
  const senderLower = email.sender.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  // Common automated sender patterns
  const automatedSenderPatterns = [
    "noreply@",
    "no-reply@",
    "donotreply@",
    "do-not-reply@",
    "newsletter@",
    "notifications@",
    "updates@",
    "marketing@",
    "promo@",
    "deals@",
    "info@",
    "support@",
    "mailer-daemon@",
    "postmaster@",
  ];

  // Check sender patterns
  if (automatedSenderPatterns.some((p) => senderLower.includes(p))) {
    return true;
  }

  // Common newsletter subject patterns
  const newsletterSubjectPatterns = [
    "[newsletter]",
    "[digest]",
    "[weekly]",
    "[monthly]",
    "[daily]",
    "unsubscribe",
    "weekly roundup",
    "daily digest",
    "newsletter:",
  ];

  if (newsletterSubjectPatterns.some((p) => subjectLower.includes(p))) {
    return true;
  }

  return false;
}

/**
 * Parse email address from "Name <email@example.com>" format.
 */
function parseEmailAddress(fromHeader: string): { name: string; email: string } {
  // Match "Name <email>" or just "email"
  const match = fromHeader.match(/^(?:(.+?)\s*)?<?([^\s<>]+@[^\s<>]+)>?$/);
  if (match) {
    return {
      name: match[1]?.trim() || match[2],
      email: match[2].toLowerCase(),
    };
  }
  return { name: fromHeader, email: fromHeader.toLowerCase() };
}

/**
 * Sync Gmail emails from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 */
export const syncGmailMessages = mutation({
  args: {
    workosUserId: v.string(),
    emails: v.array(gmailEmailInput),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncGmailMessagesInternal(ctx, user._id, args.emails);
  },
});

/**
 * Internal sync logic for Gmail messages.
 */
async function syncGmailMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  emails: GmailEmailInput[]
) {
  const result = {
    messagesCount: 0,
    conversationsCount: 0,
    skippedNewsletters: 0,
    errors: [] as string[],
  };

  // Filter out newsletters/automated emails
  const personalEmails = emails.filter((email) => {
    if (isNewsletterOrAutomated(email)) {
      result.skippedNewsletters++;
      return false;
    }
    return true;
  });

  // Group emails by threadId for efficient processing
  const emailsByThread = new Map<string, GmailEmailInput[]>();
  for (const email of personalEmails) {
    const existing = emailsByThread.get(email.threadId) ?? [];
    existing.push(email);
    emailsByThread.set(email.threadId, existing);
  }

  // Batch fetch existing conversations
  const threadIds = [...emailsByThread.keys()];
  const existingConversations = await batchFetchGmailConversations(
    ctx,
    userId,
    threadIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // Batch fetch existing messages
  const messageIds = personalEmails.map((e) => e.id);
  const existingMessages = await batchFetchGmailMessages(ctx, userId, messageIds);
  const existingMessageSet = new Set(
    existingMessages.map((m) => m.platformMessageId)
  );

  // Process each thread's emails
  for (const [threadId, threadEmails] of emailsByThread) {
    try {
      // Get or create conversation
      let conversationId = conversationMap.get(threadId);
      const firstEmail = threadEmails[0];
      const parsed = parseEmailAddress(firstEmail.sender);

      if (!conversationId) {
        conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "gmail",
          platformConversationId: threadId,
          conversationType: "dm",
          participantContactIds: [],
          unreadCount: 0,
          displayName: firstEmail.subject || parsed.name,
        });
        conversationMap.set(threadId, conversationId);
        result.conversationsCount++;
      }

      // Insert new messages and collect participant contacts
      let latestMessage: { text: string; timestamp: number } | null = null;
      const threadParticipantIds = new Set<Id<"contacts">>();

      for (const email of threadEmails) {
        // Resolve sender email to contact (always, for participant tracking)
        const senderParsed = parseEmailAddress(email.sender);
        const senderContactId = await getOrCreateEmailContact(
          ctx,
          userId,
          senderParsed.email,
          senderParsed.name
        );

        // Track participant for conversation
        threadParticipantIds.add(senderContactId);

        // Skip message insert if already exists
        if (existingMessageSet.has(email.id)) {
          continue;
        }

        const sentAtMs = new Date(email.date).getTime();

        // Combine subject and body for message content
        const content = email.body
          ? `${email.subject}\n\n${email.body}`
          : email.subject;

        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "gmail",
          content,
          sentAt: sentAtMs,
          senderContactId,
          isFromMe: false, // Nango sync gets received emails
          platformMessageId: email.id,
        });

        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || sentAtMs > latestMessage.timestamp) {
          latestMessage = { text: email.subject, timestamp: sentAtMs };
        }
      }

      // Update conversation with participants and lastMessage
      const updates: {
        lastMessageText?: string;
        lastMessageAt?: number;
        participantContactIds?: Id<"contacts">[];
      } = {};

      if (latestMessage) {
        updates.lastMessageText = latestMessage.text;
        updates.lastMessageAt = latestMessage.timestamp;
      }

      if (threadParticipantIds.size > 0) {
        // Merge with existing participants
        const existingConv = await ctx.db.get(conversationId);
        const existingIds = new Set(existingConv?.participantContactIds ?? []);
        for (const id of threadParticipantIds) {
          existingIds.add(id);
        }
        updates.participantContactIds = Array.from(existingIds);
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(conversationId, updates);
      }
    } catch (e) {
      result.errors.push(`Failed to sync thread ${threadId}: ${e}`);
    }
  }

  return result;
}

/**
 * Get or create a contact for an email address.
 */
async function getOrCreateEmailContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string,
  displayName: string
): Promise<Id<"contacts">> {
  const normalizedEmail = email.toLowerCase();

  // Check if we already have a handle for this email
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", normalizedEmail)
    )
    .unique();

  if (existingHandle) {
    // Update display name if we have a better one
    if (displayName && displayName !== email) {
      const existingContact = await ctx.db.get(existingHandle.contactId);
      if (existingContact && existingContact.displayName === email) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create placeholder contact
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || email,
  });

  // Create handle for email
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "email",
    handle: normalizedEmail,
    platform: "gmail",
  });

  return contactId;
}

/**
 * Batch fetch existing Gmail conversations by thread ID.
 */
async function batchFetchGmailConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  threadIds: string[]
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  const batchSize = 50;
  for (let i = 0; i < threadIds.length; i += batchSize) {
    const batch = threadIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "gmail")
            .eq("platformConversationId", id)
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
 * Batch fetch existing Gmail messages by message ID.
 */
async function batchFetchGmailMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageIds: string[]
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  const batchSize = 50;
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q.eq("userId", userId).eq("platform", "gmail").eq("platformMessageId", id)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((m): m is Doc<"messages"> => m !== null));
  }

  return results;
}

// ============================================================================
// Slack Message Sync
// ============================================================================

// Validator for Slack message input (from Nango sync)
const slackMessageInput = v.object({
  id: v.string(), // Slack ts (timestamp)
  channelId: v.string(),
  channelType: v.union(
    v.literal("im"),
    v.literal("channel"),
    v.literal("group"),
    v.literal("mpim")
  ),
  channelName: v.optional(v.string()), // Task 5.5: Channel name or DM partner name
  userId: v.optional(v.string()), // Slack user ID
  userName: v.optional(v.string()), // Task 5.5: Sender display name
  text: v.string(),
  ts: v.string(),
  threadTs: v.optional(v.string()),
  isThreadParent: v.boolean(),
  reactions: v.optional(
    v.array(
      v.object({
        name: v.string(),
        count: v.number(),
        users: v.array(v.string()),
      })
    )
  ),
  isBot: v.boolean(),
  sentAt: v.string(), // ISO date string
});

type SlackMessageInput = Infer<typeof slackMessageInput>;

/**
 * Sync Slack messages from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 */
export const syncSlackMessages = mutation({
  args: {
    workosUserId: v.string(), // From webhook payload
    messages: v.array(slackMessageInput),
  },
  handler: async (ctx, args) => {
    // Find user by WorkOS ID (webhook doesn't have auth context)
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncSlackMessagesInternal(ctx, user._id, args.messages);
  },
});

/**
 * Internal sync logic for Slack messages.
 */
async function syncSlackMessagesInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  messages: SlackMessageInput[]
) {
  const result = {
    messagesCount: 0,
    conversationsCount: 0,
    errors: [] as string[],
  };

  // Group messages by channel for efficient processing
  const messagesByChannel = new Map<string, SlackMessageInput[]>();
  for (const msg of messages) {
    const existing = messagesByChannel.get(msg.channelId) ?? [];
    existing.push(msg);
    messagesByChannel.set(msg.channelId, existing);
  }

  // Batch fetch existing conversations
  const channelIds = [...messagesByChannel.keys()];
  const existingConversations = await batchFetchSlackConversations(
    ctx,
    userId,
    channelIds
  );
  const conversationMap = new Map(
    existingConversations.map((c) => [c.platformConversationId, c._id])
  );

  // Batch fetch existing messages
  const messageIds = messages.map((m) => m.ts);
  const existingMessages = await batchFetchSlackMessages(ctx, userId, messageIds);
  const existingMessageSet = new Set(existingMessages.map((m) => m.platformMessageId));

  // Process each channel's messages
  for (const [channelId, channelMessages] of messagesByChannel) {
    try {
      // Get or create conversation
      let conversationId = conversationMap.get(channelId);
      const firstMsg = channelMessages[0];

      if (!conversationId) {
        const conversationType = getConversationType(firstMsg.channelType);

        conversationId = await ctx.db.insert("conversations", {
          userId,
          platform: "slack",
          platformConversationId: channelId,
          conversationType,
          participantContactIds: [], // Will be populated when we resolve users
          unreadCount: 0,
          displayName: firstMsg.channelName, // Task 5.5: Store channel name
        });
        conversationMap.set(channelId, conversationId);
        result.conversationsCount++;
      } else if (firstMsg.channelName) {
        // Update display name if we have one and it's not set
        const existingConv = existingConversations.find(
          (c) => c.platformConversationId === channelId
        );
        if (existingConv && !existingConv.displayName) {
          await ctx.db.patch(conversationId, {
            displayName: firstMsg.channelName,
          });
        }
      }

      // Insert new messages
      let latestMessage: { text: string; timestamp: number } | null = null;

      for (const msg of channelMessages) {
        // Skip if already exists
        if (existingMessageSet.has(msg.ts)) {
          continue;
        }

        // Skip bot messages
        if (msg.isBot) {
          continue;
        }

        // Resolve Slack user to contact (with display name if available)
        let senderContactId: Id<"contacts"> | undefined;
        if (msg.userId) {
          senderContactId = await getOrCreateSlackContact(
            ctx,
            userId,
            msg.userId,
            msg.userName // Task 5.5: Pass user display name
          );
        }

        const sentAtMs = new Date(msg.sentAt).getTime();

        // Map reactions to our format
        const reactions = msg.reactions?.map((r) => ({
          emoji: `:${r.name}:`,
          contactId: undefined as Id<"contacts"> | undefined, // TODO: resolve first user
          isFromMe: false,
          timestamp: sentAtMs,
        }));

        await ctx.db.insert("messages", {
          userId,
          conversationId,
          platform: "slack",
          content: msg.text,
          sentAt: sentAtMs,
          senderContactId,
          isFromMe: false, // Nango sync only gets messages from others
          platformMessageId: msg.ts,
          // Task 5.5: Store thread info
          threadTs: msg.threadTs,
          isThreadParent: msg.isThreadParent,
          reactions: reactions && reactions.length > 0 ? reactions : undefined,
        });

        result.messagesCount++;

        // Track latest message for conversation update
        if (!latestMessage || sentAtMs > latestMessage.timestamp) {
          latestMessage = { text: msg.text, timestamp: sentAtMs };
        }
      }

      // Update conversation lastMessage
      if (latestMessage) {
        await ctx.db.patch(conversationId, {
          lastMessageText: latestMessage.text,
          lastMessageAt: latestMessage.timestamp,
        });
      }
    } catch (e) {
      result.errors.push(`Failed to sync channel ${channelId}: ${e}`);
    }
  }

  return result;
}

/**
 * Map Slack channel type to our conversation type.
 */
function getConversationType(
  channelType: "im" | "channel" | "group" | "mpim"
): "dm" | "group" | "channel" {
  switch (channelType) {
    case "im":
      return "dm";
    case "mpim":
    case "group":
      return "group";
    case "channel":
      return "channel";
  }
}

/**
 * Get or create a contact for a Slack user ID.
 * Task 5.5: Also updates display name if we have a better one.
 */
async function getOrCreateSlackContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  slackUserId: string,
  displayName?: string
): Promise<Id<"contacts">> {
  // Check if we already have a handle for this Slack user
  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) =>
      q.eq("userId", userId).eq("handle", slackUserId)
    )
    .unique();

  if (existingHandle) {
    // Update display name if we have a better one (not just a Slack user ID)
    if (displayName) {
      const existingContact = await ctx.db.get(existingHandle.contactId);
      if (
        existingContact &&
        existingContact.displayName.startsWith("U") &&
        existingContact.displayName === slackUserId
      ) {
        await ctx.db.patch(existingHandle.contactId, { displayName });
      }
    }
    return existingHandle.contactId;
  }

  // Create placeholder contact with display name or Slack user ID
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: displayName || slackUserId,
  });

  // Create handle for Slack user ID
  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType: "slack_id",
    handle: slackUserId,
    platform: "slack",
  });

  return contactId;
}

/**
 * Batch fetch existing Slack conversations by channel ID.
 */
async function batchFetchSlackConversations(
  ctx: MutationCtx,
  userId: Id<"users">,
  channelIds: string[]
): Promise<Doc<"conversations">[]> {
  const results: Doc<"conversations">[] = [];

  const batchSize = 50;
  for (let i = 0; i < channelIds.length; i += batchSize) {
    const batch = channelIds.slice(i, i + batchSize);
    const promises = batch.map((id) =>
      ctx.db
        .query("conversations")
        .withIndex("by_platform_conversation", (q) =>
          q
            .eq("userId", userId)
            .eq("platform", "slack")
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
 * Batch fetch existing Slack messages by timestamp.
 */
async function batchFetchSlackMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageTs: string[]
): Promise<Doc<"messages">[]> {
  const results: Doc<"messages">[] = [];

  const batchSize = 50;
  for (let i = 0; i < messageTs.length; i += batchSize) {
    const batch = messageTs.slice(i, i + batchSize);
    const promises = batch.map((ts) =>
      ctx.db
        .query("messages")
        .withIndex("by_platform_message", (q) =>
          q.eq("userId", userId).eq("platform", "slack").eq("platformMessageId", ts)
        )
        .unique()
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((m): m is Doc<"messages"> => m !== null));
  }

  return results;
}

// ============================================================================
// Google Contacts Sync
// ============================================================================

// Validator for Google Contact input (from Nango sync)
const googleContactInput = v.object({
  id: v.string(), // resourceName from Google People API
  name: v.string(),
  emails: v.array(v.string()),
  phones: v.array(v.string()),
  company: v.optional(v.string()),
  title: v.optional(v.string()),
  isDeleted: v.boolean(),
});

type GoogleContactInput = Infer<typeof googleContactInput>;

/**
 * Sync Google Contacts from Nango to Convex.
 * Called via API endpoint when Nango sync completes.
 *
 * This mutation:
 * 1. Upserts contacts by email/phone handle
 * 2. Links handles to contact records
 * 3. Merges with existing iMessage contacts by phone number
 * 4. Handles deleted contacts from Google
 */
export const syncGoogleContacts = mutation({
  args: {
    workosUserId: v.string(),
    contacts: v.array(googleContactInput),
  },
  handler: async (ctx, args) => {
    const user = await findUserByWorkosId(ctx, args.workosUserId);
    if (!user) {
      throw new Error(`User not found for WorkOS ID: ${args.workosUserId}`);
    }

    return syncGoogleContactsInternal(ctx, user._id, args.contacts);
  },
});

/**
 * Internal sync logic for Google Contacts.
 */
async function syncGoogleContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  contacts: GoogleContactInput[]
) {
  const result = {
    contactsCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    handlesCount: 0,
    errors: [] as string[],
  };

  for (const contact of contacts) {
    try {
      // Handle deleted contacts
      if (contact.isDeleted) {
        // Find and soft-delete the contact if it exists
        const deleted = await handleDeletedGoogleContact(ctx, userId, contact);
        if (deleted) {
          result.deletedCount++;
        }
        continue;
      }

      // Skip contacts with no identifiable handles
      if (contact.emails.length === 0 && contact.phones.length === 0) {
        continue;
      }

      const syncResult = await upsertGoogleContact(ctx, userId, contact);
      if (syncResult.isNew) {
        result.contactsCount++;
      } else {
        result.updatedCount++;
      }
      result.handlesCount += syncResult.handlesAdded;
    } catch (e) {
      result.errors.push(`Failed to sync contact ${contact.name}: ${e}`);
    }
  }

  return result;
}

/**
 * Handle a deleted Google Contact.
 * Finds the contact by any handle and removes Google-specific handles.
 */
async function handleDeletedGoogleContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: GoogleContactInput
): Promise<boolean> {
  // Collect all handles to find the contact
  const allHandles = [
    ...contact.emails.map((e) => e.toLowerCase()),
    ...contact.phones.map((p) => normalizePhone(p)),
  ];

  for (const handle of allHandles) {
    const existingHandle = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle)
      )
      .unique();

    if (existingHandle) {
      // Remove handles that came from Gmail (not iMessage or Slack)
      // We identify Gmail handles by checking if they're email type
      const handlesByContact = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", existingHandle.contactId))
        .collect();

      for (const h of handlesByContact) {
        // Only delete email handles from gmail platform
        if (h.platform === "gmail" && h.handleType === "email") {
          await ctx.db.delete(h._id);
        }
      }

      // Check if contact has any remaining handles
      const remainingHandles = await ctx.db
        .query("contactHandles")
        .withIndex("by_contact", (q) => q.eq("contactId", existingHandle.contactId))
        .first();

      // If no handles remain, delete the contact too
      if (!remainingHandles) {
        await ctx.db.delete(existingHandle.contactId);
      }

      return true;
    }
  }

  return false;
}

/**
 * Upsert a Google Contact by finding existing contact via any of its handles,
 * or creating a new one if no match found.
 * Merges with existing iMessage/Slack contacts by phone/email.
 */
async function upsertGoogleContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: GoogleContactInput
): Promise<{ isNew: boolean; handlesAdded: number }> {
  // Collect all normalized handles
  const handles: Array<{ value: string; type: "phone" | "email" }> = [
    ...contact.phones.map((p) => ({
      value: normalizePhone(p),
      type: "phone" as const,
    })),
    ...contact.emails.map((e) => ({
      value: e.toLowerCase(),
      type: "email" as const,
    })),
  ];

  // Find existing contact by any handle (including iMessage phones)
  let contactId: Id<"contacts"> | null = null;
  for (const handle of handles) {
    contactId = await findContactByHandle(ctx, userId, handle);
    if (contactId) break;
  }

  const isNew = contactId === null;
  const contactData: {
    displayName: string;
    company?: string;
  } = {
    displayName: contact.name || contact.emails[0] || contact.phones[0] || "Unknown",
  };

  // Only set company if we have one
  if (contact.company) {
    contactData.company = contact.company;
  }

  if (contactId) {
    // Update existing contact with Google data (only if we have better info)
    const existingContact = await ctx.db.get(contactId);
    if (existingContact) {
      const updates: { displayName?: string; company?: string } = {};

      // Update display name if current is just a handle/placeholder
      if (
        contact.name &&
        (existingContact.displayName.includes("@") ||
          existingContact.displayName.startsWith("+") ||
          existingContact.displayName.match(/^\d+$/))
      ) {
        updates.displayName = contact.name;
      }

      // Update company if not set
      if (contact.company && !existingContact.company) {
        updates.company = contact.company;
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(contactId, updates);
      }
    }
  } else {
    // Create new contact
    contactId = await ctx.db.insert("contacts", { userId, ...contactData });
  }

  // Add missing handles (link to existing contact)
  let handlesAdded = 0;
  for (const handle of handles) {
    const existing = await ctx.db
      .query("contactHandles")
      .withIndex("by_user_handle", (q) =>
        q.eq("userId", userId).eq("handle", handle.value)
      )
      .unique();

    if (!existing) {
      // Add new handle linked to this contact
      await ctx.db.insert("contactHandles", {
        userId,
        contactId,
        handleType: handle.type,
        handle: handle.value,
        platform: "gmail", // Google Contacts sync uses gmail platform
      });
      handlesAdded++;
    } else if (existing.contactId !== contactId) {
      // Handle exists but linked to different contact - update to primary contact
      await ctx.db.patch(existing._id, { contactId });
    }
  }

  return { isNew, handlesAdded };
}

// ============================================================================
// Social Contacts Sync (LinkedIn, Twitter)
// ============================================================================

const socialContactInput = v.object({
  name: v.string(),
  handle: v.string(),
  profileUrl: v.string(),
  headline: v.union(v.string(), v.null()),
});

const socialPlatformValidator = v.union(
  v.literal("linkedin"),
  v.literal("twitter")
);

type SocialContactInput = Infer<typeof socialContactInput>;
type SocialPlatform = Infer<typeof socialPlatformValidator>;

/**
 * Sync social contacts from Electron scrapers to Convex.
 */
export const syncSocialContacts = mutation({
  args: {
    platform: socialPlatformValidator,
    contacts: v.array(socialContactInput),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: Must be authenticated to sync social contacts");
    }

    const user = await getOrCreateUser(ctx, identity);
    return syncSocialContactsInternal(ctx, user._id, args.platform, args.contacts, args.syncedAt);
  },
});

async function syncSocialContactsInternal(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SocialPlatform,
  contacts: SocialContactInput[],
  syncedAt: number
) {
  const result = {
    totalContacts: contacts.length,
    newContacts: 0,
    updatedContacts: 0,
    actionsCreated: 0,
    errors: [] as string[],
  };

  const handleType = platform === "linkedin" ? "linkedin_url" : "twitter_handle";
  const newContactsInfo: Array<{
    contactId: Id<"contacts">;
    headline: string | null;
    profileUrl: string;
  }> = [];

  for (const contact of contacts) {
    try {
      const upsertResult = await upsertSocialContact(ctx, userId, platform, handleType, contact);
      if (upsertResult.isNew) {
        result.newContacts++;
        newContactsInfo.push({
          contactId: upsertResult.contactId,
          headline: contact.headline,
          profileUrl: contact.profileUrl,
        });
      } else {
        result.updatedContacts++;
      }
    } catch (e) {
      result.errors.push(`Failed to sync ${contact.name}: ${e}`);
    }
  }

  // Task 8.6: Schedule merge candidate search for each new contact
  // This will auto-merge high confidence matches and create suggestions for medium confidence
  for (const info of newContactsInfo) {
    await ctx.scheduler.runAfter(0, internal.contactResolution.findMergeCandidatesForContact, {
      userId,
      contactId: info.contactId,
    });
  }

  // Task 8.7: Create new_connection actions for enrichment (limit 20 per sync)
  const MAX_NEW_CONNECTION_ACTIONS = 20;
  const actionsToCreate = newContactsInfo.slice(0, MAX_NEW_CONNECTION_ACTIONS);
  const now = Date.now();

  for (const info of actionsToCreate) {
    await ctx.db.insert("actions", {
      userId,
      type: "new_connection",
      status: "pending",
      priority: 40, // Medium-low priority for enrichment prompts
      contactId: info.contactId,
      platform,
      llmReason: info.headline ?? undefined, // Store headline in llmReason field
      reason: info.profileUrl, // Store profileUrl in reason field
      createdAt: now,
    });
    result.actionsCreated++;
  }

  // Increment pending action count for user
  if (result.actionsCreated > 0) {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        pendingActionCount: (user.pendingActionCount ?? 0) + result.actionsCreated,
      });
    }
  }

  // Update integration sync state
  const integration = await getOrCreateIntegration(ctx, userId, platform);
  await ctx.db.patch(integration._id, {
    syncState: {
      ...integration.syncState,
      lastSyncAt: syncedAt,
      lastError: undefined,
      totalContactsSynced: (integration.syncState.totalContactsSynced ?? 0) + result.newContacts,
    },
  });

  return result;
}

function extractCompanyFromHeadline(headline: string | null): string | undefined {
  if (!headline) return undefined;
  const match = headline.match(/\s+(?:at|@)\s+(.+?)(?:\s*[|•·-]|$)/i);
  return match ? match[1].trim() : undefined;
}

async function upsertSocialContact(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: SocialPlatform,
  handleType: "linkedin_url" | "twitter_handle",
  contact: SocialContactInput
): Promise<{ isNew: boolean; contactId: Id<"contacts"> }> {
  const normalizedHandle =
    platform === "linkedin"
      ? contact.profileUrl.split("?")[0].toLowerCase()
      : contact.handle.toLowerCase().replace(/^@/, "");

  const existingHandle = await ctx.db
    .query("contactHandles")
    .withIndex("by_user_handle", (q) => q.eq("userId", userId).eq("handle", normalizedHandle))
    .unique();

  if (existingHandle) {
    const existingContact = await ctx.db.get(existingHandle.contactId);
    if (existingContact) {
      const company = extractCompanyFromHeadline(contact.headline);
      if (company && !existingContact.company) {
        await ctx.db.patch(existingHandle.contactId, { company });
      }
    }
    return { isNew: false, contactId: existingHandle.contactId };
  }

  const company = extractCompanyFromHeadline(contact.headline);
  const contactId = await ctx.db.insert("contacts", {
    userId,
    displayName: contact.name,
    company,
  });

  await ctx.db.insert("contactHandles", {
    userId,
    contactId,
    handleType,
    handle: normalizedHandle,
    platform,
  });

  return { isNew: true, contactId };
}


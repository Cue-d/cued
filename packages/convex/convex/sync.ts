import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// Input types matching @prm/integrations SyncBatch structure
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

/** Input type for chat data */
type ChatInput = {
  id: number;
  identifier: string;
  displayName: string | null;
  isGroup: boolean;
  participants: { id: number; identifier: string; service: string }[];
};

/** Input type for message data */
type MessageInput = {
  id: number;
  text: string | null;
  timestamp: number;
  isFromMe: boolean;
};

/** Full message input with sender info */
type FullMessageInput = {
  id: number;
  chatId: number;
  text: string | null;
  timestamp: number;
  isFromMe: boolean;
  isRead: boolean;
  readAt: number | null;
  hasAttachments: boolean;
  sender: { id: number; identifier: string; service: string } | null;
};

/** Batch input type */
type BatchInput = {
  cursor: number;
  chats: ChatInput[];
  messages: FullMessageInput[];
  handles: { id: number; identifier: string; service: string }[];
};

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
 * Test-only mutation for syncing without auth (dev environment only).
 * Uses a hardcoded test user for local testing.
 */
export const syncMessagesTest = mutation({
  args: {
    batch: syncBatchInput,
  },
  handler: async (ctx, args) => {
    const testEmail = "test@prm.local";
    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", testEmail))
      .unique();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        workosUserId: "test-user-dev",
        email: testEmail,
        name: "Test User",
      });
      user = (await ctx.db.get(userId))!;
    }

    return syncMessagesInternal(ctx, user._id, args.batch);
  },
});

/**
 * Internal sync logic shared by authenticated and test mutations.
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

      await upsertMessage(ctx, userId, conversationId, message, senderContactId);
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

  // Check if message exists (no index on platformMessageId, filter by conversation)
  const existingMessages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();

  const alreadyExists = existingMessages.some(
    (m) => m.platformMessageId === platformMessageId
  );

  if (alreadyExists) {
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
 * - Phone numbers: strip non-digits, keep + prefix
 * - Emails: lowercase
 */
function normalizeHandle(handle: string): string {
  if (handle.includes("@")) {
    return handle.toLowerCase();
  }

  // Phone number: keep + prefix, strip other non-digits
  const hasPlus = handle.startsWith("+");
  const digits = handle.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

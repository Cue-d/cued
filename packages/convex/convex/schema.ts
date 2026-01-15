import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared enum validators for type safety and reusability
export const platformValidator = v.union(
  v.literal("imessage"),
  v.literal("gmail"),
  v.literal("slack")
);

export const handleTypeValidator = v.union(
  v.literal("phone"),
  v.literal("email"),
  v.literal("slack_id")
);

export const conversationTypeValidator = v.union(
  v.literal("dm"),
  v.literal("group"),
  v.literal("channel")
);

export const actionTypeValidator = v.union(
  v.literal("respond"),
  v.literal("follow_up"),
  v.literal("send_message"),
  v.literal("eod_contact")
);

export const actionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("completed"),
  v.literal("discarded"),
  v.literal("snoozed")
);

export const messageStatusValidator = v.union(
  v.literal("sending"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("failed")
);

const schema = defineSchema({
  // Task 1.7: Users table
  users: defineTable({
    workosUserId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    plan: v.optional(v.string()),
  })
    .index("by_workos_id", ["workosUserId"])
    .index("by_email", ["email"]),

  // Task 1.8: Integrations table
  integrations: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    pipedreamAccountId: v.optional(v.string()),
    nangoConnectionId: v.optional(v.string()), // Task 4.5: Nango connection ID for Gmail/Slack
    connectedAt: v.optional(v.number()), // Task 4.5: When the integration was connected
    syncState: v.object({
      isConnected: v.boolean(),
      lastSyncAt: v.optional(v.number()),
      lastSyncCursor: v.optional(v.string()),
      lastError: v.optional(v.string()),
      // Task 2.8a: Extended sync metadata for recovery
      totalMessagesSynced: v.optional(v.number()),
      totalContactsSynced: v.optional(v.number()),
      syncVersion: v.optional(v.number()), // Increment when schema changes require re-sync
      // Task 2.7c: Contacts sync state for recovery
      lastContactsSyncAt: v.optional(v.number()),
      // Task 3.13b: Memory extraction tracking
      lastMemoryProcessedAt: v.optional(v.number()), // sentAt timestamp of last processed message
      totalMessagesProcessedForMemory: v.optional(v.number()),
      totalMemoriesExtracted: v.optional(v.number()),
    }),
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"]),

  // Task 1.9: Contacts and ContactHandles tables
  contacts: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    company: v.optional(v.string()),
    notes: v.optional(v.string()),
    importance: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .searchIndex("search_display_name", {
      searchField: "displayName",
      filterFields: ["userId"],
    }),

  contactHandles: defineTable({
    userId: v.id("users"),
    contactId: v.id("contacts"),
    handleType: handleTypeValidator,
    handle: v.string(), // normalized value (e.g., E.164 phone, lowercase email)
    platform: platformValidator,
  })
    .index("by_user", ["userId"])
    .index("by_user_handle", ["userId", "handle"])
    .index("by_contact", ["contactId"]),

  // Task 1.10: Conversations table
  conversations: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    platformConversationId: v.string(), // chat.db chat_id, Gmail threadId, Slack channel+thread
    conversationType: conversationTypeValidator,
    participantContactIds: v.array(v.id("contacts")), // references to contacts table
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()), // timestamp in milliseconds
    unreadCount: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_last_message", ["userId", "lastMessageAt"])
    .index("by_platform_conversation", ["userId", "platform", "platformConversationId"]),

  // Task 1.11: Messages table
  messages: defineTable({
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    platform: platformValidator,
    content: v.string(),
    sentAt: v.number(), // timestamp in milliseconds
    senderContactId: v.optional(v.id("contacts")), // null if isFromMe=true
    isFromMe: v.boolean(),
    platformMessageId: v.string(), // unique ID from source platform (ROWID, Gmail msgId, Slack ts)
    // Task 2.2b: Message status and reactions
    status: v.optional(messageStatusValidator), // sent, delivered, read, failed
    reactions: v.optional(
      v.array(
        v.object({
          emoji: v.string(),
          contactId: v.optional(v.id("contacts")), // null if isFromMe
          isFromMe: v.boolean(),
          timestamp: v.number(),
        })
      )
    ),
    // Task 2.2c: Attachments
    attachments: v.optional(
      v.array(
        v.object({
          filename: v.string(),
          mimeType: v.string(),
          size: v.number(),
          storageId: v.id("_storage"), // Convex file storage ID
          thumbnailStorageId: v.optional(v.id("_storage")), // thumbnail for images/videos
        })
      )
    ),
    // Task 3.13c: Track when memory was extracted from this message
    memoryExtractedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_conversation", ["conversationId", "sentAt"])
    .index("by_platform_message", ["userId", "platform", "platformMessageId"])
    .index("by_user_sent_at", ["userId", "sentAt"]) // Task 3.13b: For memory extraction pagination
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "conversationId"],
    }),

  // Task 1.12: Actions table
  actions: defineTable({
    userId: v.id("users"),
    type: actionTypeValidator,
    status: actionStatusValidator,
    priority: v.number(), // 0-100 priority score
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    messageId: v.optional(v.id("messages")),
    draftMessage: v.optional(v.string()),
    reason: v.optional(v.string()),
    snoozedUntil: v.optional(v.number()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),
});

export default schema;

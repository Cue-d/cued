import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared enum validators for type safety and reusability
export const platformValidator = v.union(
  v.literal("imessage"),
  v.literal("gmail"),
  v.literal("slack"),
  v.literal("linkedin"),
  v.literal("twitter")
);

export const handleTypeValidator = v.union(
  v.literal("phone"),
  v.literal("email"),
  v.literal("slack_id"),
  v.literal("linkedin_url"),
  v.literal("twitter_handle")
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
  v.literal("eod_contact"),
  v.literal("resolve_contact"),
  v.literal("new_connection")
);

export const mergeSuggestionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected")
);

export const mergeSourceValidator = v.union(
  v.literal("email_match"),
  v.literal("phone_match"),
  v.literal("name_match"),
  v.literal("llm_match")
);

export const actionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("completed"),
  v.literal("discarded"),
  v.literal("snoozed"),
  v.literal("expired")
);

export const analysisQueueStatusValidator = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("skipped")
);

export const messageStatusValidator = v.union(
  v.literal("sending"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("failed")
);

const schema = defineSchema({
  users: defineTable({
    workosUserId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    plan: v.optional(v.string()),
    // Denormalized counter for efficient action badge queries
    pendingActionCount: v.optional(v.number()),
  })
    .index("by_workos_id", ["workosUserId"])
    .index("by_email", ["email"]),

  integrations: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    pipedreamAccountId: v.optional(v.string()),
    nangoConnectionId: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
    syncState: v.object({
      isConnected: v.boolean(),
      lastSyncAt: v.optional(v.number()),
      lastSyncCursor: v.optional(v.string()),
      lastError: v.optional(v.string()),
      totalMessagesSynced: v.optional(v.number()),
      totalContactsSynced: v.optional(v.number()),
      syncVersion: v.optional(v.number()),
      lastContactsSyncAt: v.optional(v.number()),
      lastMemoryProcessedAt: v.optional(v.number()),
      totalMessagesProcessedForMemory: v.optional(v.number()),
      totalMemoriesExtracted: v.optional(v.number()),
    }),
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"]),

  contacts: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    company: v.optional(v.string()),
    notes: v.optional(v.string()),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    isDismissed: v.optional(v.boolean()),
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

  conversations: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    platformConversationId: v.string(), // chat.db chat_id, Gmail threadId, Slack channel+thread
    conversationType: conversationTypeValidator,
    participantContactIds: v.array(v.id("contacts")), // references to contacts table
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()), // timestamp in milliseconds
    unreadCount: v.number(),
    displayName: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_last_message", ["userId", "lastMessageAt"])
    .index("by_platform_conversation", ["userId", "platform", "platformConversationId"]),

  messages: defineTable({
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    platform: platformValidator,
    content: v.string(),
    sentAt: v.number(), // timestamp in milliseconds
    senderContactId: v.optional(v.id("contacts")), // null if isFromMe=true
    isFromMe: v.boolean(),
    platformMessageId: v.string(),
    threadTs: v.optional(v.string()),
    isThreadParent: v.optional(v.boolean()),
    status: v.optional(messageStatusValidator),
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
    attachments: v.optional(
      v.array(
        v.object({
          filename: v.string(),
          mimeType: v.string(),
          size: v.number(),
          storageId: v.id("_storage"), // Convex file storage ID
          thumbnailStorageId: v.optional(v.id("_storage")),
        })
      )
    ),
    memoryExtractedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_conversation", ["conversationId", "sentAt"])
    .index("by_platform_message", ["userId", "platform", "platformMessageId"])
    .index("by_user_sent_at", ["userId", "sentAt"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "conversationId"],
    }),

  // Actions table
  actions: defineTable({
    userId: v.id("users"),
    type: actionTypeValidator,
    status: actionStatusValidator,
    priority: v.number(),
    // References
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    messageId: v.optional(v.id("messages")),
    secondaryContactId: v.optional(v.id("contacts")), // For resolve_contact actions
    mergeSuggestionId: v.optional(v.id("mergeSuggestions")), // For resolve_contact actions
    platform: v.optional(platformValidator),
    // Drafts: draftMessage = AI-suggested, draftResponse = user-edited
    draftMessage: v.optional(v.string()),
    draftResponse: v.optional(v.string()),
    // Reasons: reason = heuristic/manual, llmReason = AI-generated explanation
    reason: v.optional(v.string()),
    llmReason: v.optional(v.string()),
    // Timestamps
    createdAt: v.number(),
    snoozedUntil: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    discardedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  actionAnalysisQueue: defineTable({
    conversationId: v.id("conversations"),
    userId: v.id("users"),
    status: analysisQueueStatusValidator,
    priority: v.number(),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    result: v.optional(
      v.union(
        v.literal("action_created"),
        v.literal("no_action"),
        v.literal("error")
      )
    ),
    skipReason: v.optional(v.string()),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_priority", ["status", "priority"]) // For processing order: pending first, then by priority
    .index("by_conversation", ["conversationId"]),

  mergeSuggestions: defineTable({
    userId: v.id("users"),
    contact1Id: v.id("contacts"), // Primary contact (will be kept)
    contact2Id: v.id("contacts"), // Secondary contact (will be merged into primary)
    confidence: v.number(), // 0-1 confidence score
    source: mergeSourceValidator, // How the match was detected
    reasoning: v.optional(v.string()), // Human-readable explanation
    status: mergeSuggestionStatusValidator,
    // Timestamps
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_contacts", ["contact1Id", "contact2Id"]),

  contactMemoryStats: defineTable({
    userId: v.id("users"),
    contactId: v.id("contacts"),
    displayName: v.string(), // Denormalized for display
    company: v.optional(v.string()), // Denormalized for display
    messagesProcessed: v.number(),
    memoriesExtracted: v.number(),
    lastExtractedAt: v.number(),
  })
    .index("by_user_recent", ["userId", "lastExtractedAt"])
    .index("by_contact", ["contactId"]),

  pendingSends: defineTable({
    userId: v.id("users"),
    conversationId: v.optional(v.id("conversations")), // Optional for test sends
    actionId: v.optional(v.id("actions")), // Link to action that created this
    text: v.string(),
    // Recipient info (for iMessage AppleScript)
    recipientHandle: v.string(), // Phone number or email
    isGroup: v.boolean(),
    chatIdentifier: v.optional(v.string()), // For group chats
    // Status tracking
    status: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
    // Timestamps
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    // Retry tracking
    attempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_conversation", ["conversationId"]),
});

export default schema;

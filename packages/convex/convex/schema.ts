import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared enum validators for type safety and reusability
export const platformValidator = v.union(
  v.literal("imessage"),
  v.literal("slack"),
  v.literal("linkedin"),
  v.literal("twitter"),
  v.literal("signal"),
  v.literal("whatsapp")
);

export const handleTypeValidator = v.union(
  v.literal("phone"),
  v.literal("email"),
  v.literal("slack_id"),
  v.literal("signal_id"),
  v.literal("linkedin_handle"),  // vanity URLs (linkedin)
  v.literal("linkedin_urn"),     // platform URNs (linkedin)
  v.literal("urn"),              // legacy URNs
  v.literal("twitter_handle"),
  v.literal("twitter_user_id")   // stable numeric user IDs (twitter)
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
  v.literal("exact_name_match"),
  v.literal("fuzzy_name_match"),
  v.literal("llm_fuzzy_match"),
  v.literal("linkedin_urn_match")
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

export const syncModeValidator = v.union(
  v.literal("full"),
  v.literal("incremental")
);

const schema = defineSchema({
  users: defineTable({
    workosUserId: v.string(),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
    plan: v.optional(v.string()),
    // Denormalized counter for efficient action badge queries
    pendingActionCount: v.optional(v.number()),
    // Expo push token for mobile notifications
    expoPushToken: v.optional(v.string()),
  })
    .index("by_workos_id", ["workosUserId"])
    .index("by_email", ["email"]),

  integrations: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    connectedAt: v.optional(v.number()),
    // Slack-specific: team ID for multi-workspace support
    slackTeamId: v.optional(v.string()),
    // LinkedIn-specific: user's URN for isFromMe detection
    linkedInUserURN: v.optional(v.string()),
    // Connection status (not sync status - sync state lives in syncCursors)
    isConnected: v.boolean(),
    lastError: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"])
    .index("by_user_platform_team", ["userId", "platform", "slackTeamId"]),

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
    .index("by_user_display_name", ["userId", "displayName"])
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
    platformConversationId: v.string(), // chat.db chat_id, Slack channel+thread
    conversationType: conversationTypeValidator,
    participantContactIds: v.array(v.id("contacts")), // references to contacts table
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()), // timestamp in milliseconds
    unreadCount: v.number(),
    displayName: v.optional(v.string()),
    // For Slack channels: true if user has sent a message or reacted.
    // DMs are always considered participated. Channels without participation are hidden from inbox.
    userParticipated: v.optional(v.boolean()),
    // For multi-workspace platforms (Slack teamId)
    workspaceId: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"])
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
  })
    .index("by_user", ["userId"])
    .index("by_conversation", ["conversationId", "sentAt"])
    .index("by_platform_message", ["userId", "platform", "platformMessageId"])
    .index("by_user_sent_at", ["userId", "sentAt"])
    .index("by_sender_contact", ["senderContactId"])
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
    // Denormalized merge suggestion data (for resolve_contact actions)
    mergeConfidence: v.optional(v.number()),
    mergeSource: v.optional(mergeSourceValidator),
    mergeReasoning: v.optional(v.string()),
    platform: v.optional(platformValidator),
    // Reasons: reason = heuristic/manual, llmReason = AI-generated explanation
    summary: v.optional(v.string()),
    reason: v.optional(v.string()),
    llmReason: v.optional(v.string()),
    // Embedding for similarity search (action intelligence)
    embedding: v.optional(v.array(v.float64())),
    embeddingInput: v.optional(v.string()), // Full formatted input for debugging
    // Timestamps
    createdAt: v.number(),
    snoozedUntil: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    discardedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_status_completed_at", ["userId", "status", "completedAt"])
    .index("by_user_status_discarded_at", ["userId", "status", "discardedAt"])
    .index("by_conversation_status", ["conversationId", "status"])
    .index("by_contact", ["contactId"])
    .index("by_message", ["messageId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["userId"],
    }),

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
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_status", ["conversationId", "status"]),

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

  // Device presence tracking for remote send capability
  devicePresence: defineTable({
    userId: v.id("users"),
    deviceType: v.literal("electron"), // Future: could add "mobile", "web"
    lastHeartbeatAt: v.number(),
    appVersion: v.optional(v.string()),
  })
    .index("by_user_device", ["userId", "deviceType"])
    .index("by_device_type", ["deviceType"]),

  // Cloud sync cursors for multi-device sync support
  // This is the single source of truth for sync state (replaces integrations.syncState)
  syncCursors: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    workspaceId: v.optional(v.string()), // e.g., Slack teamId
    cursorData: v.any(), // Platform-specific cursor data (historyId, timestamp, etc.)
    lastSyncAt: v.number(),
    syncMode: syncModeValidator,
    // For resumable full syncs (e.g., iMessage DESC pagination)
    fullSyncProgress: v.optional(
      v.object({
        phase: v.string(), // e.g., "messages", "contacts"
        offset: v.number(), // Current position in the full sync
      })
    ),
    // Sync stats (moved from integrations.syncState)
    totalMessagesSynced: v.optional(v.number()),
    totalContactsSynced: v.optional(v.number()),
    lastContactsSyncAt: v.optional(v.number()),
    syncVersion: v.optional(v.number()),
  })
    .index("by_user_platform", ["userId", "platform"])
    .index("by_user_platform_workspace", ["userId", "platform", "workspaceId"]),

  // Unified message queue for all platforms (replaces pendingSends)
  messageQueue: defineTable({
    userId: v.id("users"),
    platform: platformValidator,
    // Recipient info
    recipientHandle: v.string(), // Phone, email, Slack ID, LinkedIn URL, etc.
    recipientContactId: v.optional(v.id("contacts")),
    // Message content
    text: v.string(),
    // For group chats
    isGroup: v.boolean(),
    chatIdentifier: v.optional(v.string()), // Group chat ID if applicable
    // References
    conversationId: v.optional(v.id("conversations")),
    actionId: v.optional(v.id("actions")), // Link to action that created this
    // For multi-workspace platforms (Slack teamId)
    workspaceId: v.optional(v.string()),
    // Queue status
    status: v.union(
      v.literal("pending"), // Waiting to be sent
      v.literal("sending"), // Currently being sent
      v.literal("sent"), // Successfully sent
      v.literal("failed"), // Failed to send
      v.literal("cancelled") // Cancelled before send
    ),
    // Scheduling
    scheduledFor: v.number(), // Timestamp when message is eligible to send
    // Per-conversation ordering (auto-incrementing per conversationId)
    sequenceNumber: v.optional(v.number()),
    // Error handling
    error: v.optional(v.string()),
    attempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
    // Single-sender lock (per-message claim with 20s lease)
    processingDeviceId: v.optional(v.string()),
    processingStartedAt: v.optional(v.number()),
    // Timestamps
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_status", ["status"])
    .index("by_status_scheduledFor", ["status", "scheduledFor"])
    .index("by_user_status_createdAt", ["userId", "status", "createdAt"])
    .index("by_user_pending", ["userId", "scheduledFor"]) // For getting messages ready to send
    .index("by_user_platform", ["userId", "platform"])
    .index("by_conversation_sequence", ["conversationId", "sequenceNumber"]),
});

export default schema;

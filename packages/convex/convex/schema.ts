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
    syncState: v.object({
      isConnected: v.boolean(),
      lastSyncAt: v.optional(v.number()),
      lastSyncCursor: v.optional(v.string()),
      lastError: v.optional(v.string()),
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

  // Tables to be added:
  // - messages (task 1.11)
  // - actions (task 1.12)
});

export default schema;

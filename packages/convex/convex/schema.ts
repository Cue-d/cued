import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    platform: v.union(v.literal("imessage"), v.literal("gmail"), v.literal("slack")),
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
    handleType: v.union(v.literal("phone"), v.literal("email"), v.literal("slack_id")),
    handle: v.string(), // normalized value (e.g., E.164 phone, lowercase email)
    platform: v.union(v.literal("imessage"), v.literal("gmail"), v.literal("slack")),
  })
    .index("by_user", ["userId"])
    .index("by_user_handle", ["userId", "handle"])
    .index("by_contact", ["contactId"]),

  // Tables to be added:
  // - conversations (task 1.10)
  // - messages (task 1.11)
  // - actions (task 1.12)
});

export default schema;

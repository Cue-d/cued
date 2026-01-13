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

  // Tables to be added:
  // - contacts, contactHandles (task 1.9)
  // - conversations (task 1.10)
  // - messages (task 1.11)
  // - actions (task 1.12)
});

export default schema;

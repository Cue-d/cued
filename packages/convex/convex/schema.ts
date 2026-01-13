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

  // Tables to be added:
  // - integrations (task 1.8)
  // - contacts, contactHandles (task 1.9)
  // - conversations (task 1.10)
  // - messages (task 1.11)
  // - actions (task 1.12)
});

export default schema;

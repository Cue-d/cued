/**
 * Tests for integrations module.
 * Tests platform connection management.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import { createTestUserData } from "./helpers.util";

describe("integrations", () => {
  // ============================================================================
  // Integration Index Tests
  // ============================================================================
  describe("by_user_platform index", () => {
    it("enables efficient lookup by user and platform", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user with integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const integrationId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "slack",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      // Query using the index
      const found = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "slack")
          )
          .unique();
      });

      expect(found?._id).toBe(integrationId);
    });

    it("returns null for non-existent platform", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });

      const found = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "slack")
          )
          .unique();
      });

      expect(found).toBeNull();
    });
  });
});

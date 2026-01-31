/**
 * Tests for integrations module.
 * Tests multi-account support for Gmail and connection management.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "./test.setup";
import { createTestUserData } from "./helpers";
import { api } from "../_generated/api";

describe("integrations", () => {
  // ============================================================================
  // connectNango Tests
  // ============================================================================
  describe("connectNango", () => {
    it("creates new integration for first Gmail account", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user first
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });

      const result = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_123",
        email: "user@gmail.com",
      });

      expect(result.integrationId).toBeDefined();
      expect(result.updated).toBe(false);

      // Verify integration was created with accountEmail
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(result.integrationId);
      });

      expect(integration?.platform).toBe("gmail");
      expect(integration?.nangoConnectionId).toBe("conn_123");
      expect(integration?.accountEmail).toBe("user@gmail.com");
      expect(integration?.isConnected).toBe(true);
      expect(integration?.userId).toBe(userId);
    });

    it("creates new user if not exists", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `new_user_${Date.now()}`;

      const result = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_456",
        email: "newuser@gmail.com",
      });

      expect(result.integrationId).toBeDefined();
      expect(result.updated).toBe(false);

      // Verify user was created
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(result.integrationId);
      });
      const user = await t.run(async (ctx) => {
        return ctx.db.get(integration!.userId);
      });

      expect(user?.workosUserId).toBe(workosUserId);
      expect(user?.email).toBe("newuser@gmail.com");
    });

    it("allows multiple Gmail accounts (multi-account support)", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user
      await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });

      // Connect first Gmail account
      const result1 = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_account1",
        email: "account1@gmail.com",
      });

      // Connect second Gmail account (should create new integration, not update)
      const result2 = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_account2",
        email: "account2@gmail.com",
      });

      expect(result1.integrationId).not.toBe(result2.integrationId);
      expect(result2.updated).toBe(false);

      // Verify both integrations exist
      const integration1 = await t.run(async (ctx) => {
        return ctx.db.get(result1.integrationId);
      });
      const integration2 = await t.run(async (ctx) => {
        return ctx.db.get(result2.integrationId);
      });

      expect(integration1?.accountEmail).toBe("account1@gmail.com");
      expect(integration2?.accountEmail).toBe("account2@gmail.com");
    });

    it("updates existing Gmail integration when reconnecting same account with new connectionId", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user and existing Gmail integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const existingId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_old",
          accountEmail: "user@gmail.com",
          isConnected: true,
          connectedAt: Date.now() - 1000,
        });
      });

      // Reconnect same Google account but Nango issued a new connectionId
      const result = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_new_from_nango",
        email: "user@gmail.com",
      });

      // Should update existing, not create new
      expect(result.integrationId).toBe(existingId);
      expect(result.updated).toBe(true);

      // Verify integration was updated with new connectionId
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(existingId);
      });

      expect(integration?.nangoConnectionId).toBe("conn_new_from_nango");
      expect(integration?.isConnected).toBe(true);

      // Verify no duplicate was created
      const allIntegrations = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "gmail")
          )
          .collect();
      });
      expect(allIntegrations).toHaveLength(1);
    });

    it("updates existing integration when same connectionId reconnects", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user and integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const existingId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_same",
          accountEmail: "user@gmail.com",
          isConnected: false, // Was disconnected
          connectedAt: Date.now() - 1000,
        });
      });

      // Reconnect with same connectionId
      const result = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "google",
        nangoConnectionId: "conn_same",
        email: "user@gmail.com",
      });

      expect(result.integrationId).toBe(existingId);
      expect(result.updated).toBe(true);

      // Verify it was updated, not created new
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(existingId);
      });

      expect(integration?.isConnected).toBe(true);
    });

    it("updates single-account platform integration (Slack)", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user and existing Slack integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const existingId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "slack",
          nangoConnectionId: "conn_old",
          isConnected: true,
          connectedAt: Date.now() - 1000,
        });
      });

      // Connect Slack with different connectionId - should update existing
      const result = await t.mutation(api.integrations.connectNango, {
        workosUserId,
        nangoIntegrationId: "slack",
        nangoConnectionId: "conn_new",
      });

      expect(result.integrationId).toBe(existingId);
      expect(result.updated).toBe(true);

      // Verify it was updated
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(existingId);
      });

      expect(integration?.nangoConnectionId).toBe("conn_new");
    });

    it("throws for unknown integration type", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });

      await expect(
        t.mutation(api.integrations.connectNango, {
          workosUserId,
          nangoIntegrationId: "unknown_provider",
          nangoConnectionId: "conn_123",
        })
      ).rejects.toThrow("Unknown Nango integration");
    });

    it("throws error when connectionId belongs to another user", async () => {
      const t = convexTest(schema, modules);
      const workosUserId1 = `user1_${Date.now()}`;
      const workosUserId2 = `user2_${Date.now()}`;

      // Create two users
      const userId1 = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId: workosUserId1 }));
      });
      await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId: workosUserId2 }));
      });

      // Create integration for user1
      await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId: userId1,
          platform: "gmail",
          nangoConnectionId: "conn_user1",
          accountEmail: "user1@gmail.com",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      // Try to reconnect as user2 using user1's connectionId - should throw
      await expect(
        t.mutation(api.integrations.connectNango, {
          workosUserId: workosUserId2,
          nangoIntegrationId: "google",
          nangoConnectionId: "conn_user1",
          email: "attacker@gmail.com",
        })
      ).rejects.toThrow("Integration belongs to another user");
    });
  });

  // ============================================================================
  // disconnectNango Tests
  // ============================================================================
  describe("disconnectNango", () => {
    it("disconnects integration by connectionId", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user and integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const integrationId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_to_delete",
          accountEmail: "user@gmail.com",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      const result = await t.mutation(api.integrations.disconnectNango, {
        workosUserId,
        nangoConnectionId: "conn_to_delete",
      });

      expect(result.success).toBe(true);

      // Verify integration was updated
      const integration = await t.run(async (ctx) => {
        return ctx.db.get(integrationId);
      });

      expect(integration?.isConnected).toBe(false);
      expect(integration?.nangoConnectionId).toBeUndefined();
    });

    it("returns error when connection not found", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });

      const result = await t.mutation(api.integrations.disconnectNango, {
        workosUserId,
        nangoConnectionId: "nonexistent_conn",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Integration not found");
    });

    it("returns error for user mismatch", async () => {
      const t = convexTest(schema, modules);
      const workosUserId1 = `user1_${Date.now()}`;
      const workosUserId2 = `user2_${Date.now()}`;

      // Create two users
      const userId1 = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId: workosUserId1 }));
      });
      await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId: workosUserId2 }));
      });

      // Create integration for user1
      await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId: userId1,
          platform: "gmail",
          nangoConnectionId: "conn_user1",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      // Try to disconnect as user2
      const result = await t.mutation(api.integrations.disconnectNango, {
        workosUserId: workosUserId2,
        nangoConnectionId: "conn_user1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("User mismatch");
    });

    it("disconnects correct account in multi-account setup", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user with two Gmail accounts
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const integrationId1 = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_account1",
          accountEmail: "account1@gmail.com",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });
      const integrationId2 = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_account2",
          accountEmail: "account2@gmail.com",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      // Disconnect only the first account
      await t.mutation(api.integrations.disconnectNango, {
        workosUserId,
        nangoConnectionId: "conn_account1",
      });

      // Verify only first account was disconnected
      const integration1 = await t.run(async (ctx) => {
        return ctx.db.get(integrationId1);
      });
      const integration2 = await t.run(async (ctx) => {
        return ctx.db.get(integrationId2);
      });

      expect(integration1?.isConnected).toBe(false);
      expect(integration2?.isConnected).toBe(true);
    });
  });

  // ============================================================================
  // by_nango_connection Index Tests
  // ============================================================================
  describe("by_nango_connection index", () => {
    it("enables efficient lookup by connectionId", async () => {
      const t = convexTest(schema, modules);
      const workosUserId = `user_${Date.now()}`;

      // Create user with integration
      const userId = await t.run(async (ctx) => {
        return ctx.db.insert("users", createTestUserData({ workosUserId }));
      });
      const integrationId = await t.run(async (ctx) => {
        return ctx.db.insert("integrations", {
          userId,
          platform: "gmail",
          nangoConnectionId: "conn_indexed",
          accountEmail: "indexed@gmail.com",
          isConnected: true,
          connectedAt: Date.now(),
        });
      });

      // Query using the index
      const found = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_nango_connection", (q) =>
            q.eq("nangoConnectionId", "conn_indexed")
          )
          .unique();
      });

      expect(found?._id).toBe(integrationId);
      expect(found?.accountEmail).toBe("indexed@gmail.com");
    });

    it("returns null for non-existent connectionId", async () => {
      const t = convexTest(schema, modules);

      const found = await t.run(async (ctx) => {
        return ctx.db
          .query("integrations")
          .withIndex("by_nango_connection", (q) =>
            q.eq("nangoConnectionId", "nonexistent")
          )
          .unique();
      });

      expect(found).toBeNull();
    });
  });
});

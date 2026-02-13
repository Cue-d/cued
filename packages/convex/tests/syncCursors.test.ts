/**
 * Tests for syncCursors functions.
 * Tests cloud cursor storage for multi-device sync support.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import { createTestUserData, createTestIdentity } from "./helpers.util";
import { api } from "../convex/_generated/api";

/**
 * Helper to set up an authenticated test environment.
 */
async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const identity = createTestIdentity();
  const asUser = t.withIdentity(identity);

  const userId = await t.run(async (ctx) => {
    return ctx.db.insert(
      "users",
      createTestUserData({
        workosUserId: identity.subject,
      })
    );
  });

  return { asUser, userId, identity };
}

describe("syncCursors", () => {
  // ============================================================================
  // getSyncCursor Tests
  // ============================================================================
  describe("getSyncCursor", () => {
    it("returns null for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.syncCursors.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBeNull();
    });

    it("returns null when no cursor exists", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.query(api.syncCursors.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBeNull();
    });

    it("returns cursor for platform without workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor directly in DB
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: { lastMessageId: 12345 },
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      const result = await asUser.query(api.syncCursors.getSyncCursor, {
        platform: "imessage",
      });

      expect(result).not.toBeNull();
      expect(result?.platform).toBe("imessage");
      expect(result?.cursorData).toEqual({ lastMessageId: 12345 });
      expect(result?.syncMode).toBe("incremental");
    });

    it("returns cursor for platform with workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor with workspaceId
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: { conversationCursors: {}, lastSyncAt: 1000 },
          lastSyncAt: Date.now(),
          syncMode: "full",
        });
      });

      const result = await asUser.query(api.syncCursors.getSyncCursor, {
        platform: "slack",
        workspaceId: "T12345678",
      });

      expect(result).not.toBeNull();
      expect(result?.platform).toBe("slack");
      expect(result?.workspaceId).toBe("T12345678");
      expect(result?.syncMode).toBe("full");
    });

    it("returns null when workspaceId doesn't match", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor for different workspace
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "full",
        });
      });

      const result = await asUser.query(api.syncCursors.getSyncCursor, {
        platform: "slack",
        workspaceId: "T99999999", // Different workspace
      });

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // upsertSyncCursor Tests
  // ============================================================================
  describe("upsertSyncCursor", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.syncCursors.upsertSyncCursor, {
          platform: "imessage",
          cursorData: {},
          syncMode: "full",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates new cursor when none exists", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const cursorId = await asUser.mutation(api.syncCursors.upsertSyncCursor, {
        platform: "imessage",
        cursorData: { lastMessageId: 100 },
        syncMode: "full",
      });

      expect(cursorId).toBeDefined();

      // Verify cursor was created
      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor).not.toBeNull();
      expect(cursor?.userId).toBe(userId);
      expect(cursor?.platform).toBe("imessage");
      expect(cursor?.cursorData).toEqual({ lastMessageId: 100 });
      expect(cursor?.syncMode).toBe("full");
    });

    it("updates existing cursor", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create initial cursor
      const cursorId = await t.run(async (ctx) => {
        return ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: { lastMessageId: 100 },
          lastSyncAt: 1000,
          syncMode: "full",
        });
      });

      // Upsert should update
      const resultId = await asUser.mutation(api.syncCursors.upsertSyncCursor, {
        platform: "imessage",
        cursorData: { lastMessageId: 200 },
        syncMode: "incremental",
      });

      expect(resultId).toBe(cursorId);

      // Verify update
      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor?.cursorData).toEqual({ lastMessageId: 200 });
      expect(cursor?.syncMode).toBe("incremental");
      expect(cursor?.lastSyncAt).toBeGreaterThan(1000);
    });

    it("creates cursor with workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const cursorId = await asUser.mutation(api.syncCursors.upsertSyncCursor, {
        platform: "slack",
        workspaceId: "T87654321",
        cursorData: { conversationCursors: {} },
        syncMode: "incremental",
      });

      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor?.workspaceId).toBe("T87654321");
    });

    it("updates cursor with matching workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor with workspace
      const cursorId = await t.run(async (ctx) => {
        return ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: { old: true },
          lastSyncAt: 1000,
          syncMode: "full",
        });
      });

      // Upsert with matching workspace
      const resultId = await asUser.mutation(api.syncCursors.upsertSyncCursor, {
        platform: "slack",
        workspaceId: "T12345678",
        cursorData: { updated: true },
        syncMode: "incremental",
      });

      expect(resultId).toBe(cursorId);

      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor?.cursorData).toEqual({ updated: true });
    });

    it("creates new cursor for different workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor for one workspace
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: { team1: true },
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      // Upsert for different workspace should create new
      const newCursorId = await asUser.mutation(
        api.syncCursors.upsertSyncCursor,
        {
          platform: "slack",
          workspaceId: "T99999999",
          cursorData: { team2: true },
          syncMode: "full",
        }
      );

      // Should have two cursors now
      const cursors = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", userId).eq("platform", "slack")
          )
          .collect();
      });

      expect(cursors).toHaveLength(2);
      expect(cursors.find((c) => c.workspaceId === "T12345678")).toBeDefined();
      expect(cursors.find((c) => c.workspaceId === "T99999999")).toBeDefined();
    });

    it("stores fullSyncProgress", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const cursorId = await asUser.mutation(api.syncCursors.upsertSyncCursor, {
        platform: "imessage",
        cursorData: {},
        syncMode: "full",
        fullSyncProgress: { phase: "messages", offset: 500 },
      });

      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor?.fullSyncProgress).toEqual({ phase: "messages", offset: 500 });
    });
  });

  // ============================================================================
  // deleteSyncCursor Tests
  // ============================================================================
  describe("deleteSyncCursor", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.syncCursors.deleteSyncCursor, {
          platform: "imessage",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("returns false when cursor doesn't exist", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(api.syncCursors.deleteSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBe(false);
    });

    it("deletes existing cursor", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor
      const cursorId = await t.run(async (ctx) => {
        return ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      const result = await asUser.mutation(api.syncCursors.deleteSyncCursor, {
        platform: "imessage",
      });

      expect(result).toBe(true);

      // Verify deletion
      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor).toBeNull();
    });

    it("deletes cursor with matching workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor with workspace
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      const result = await asUser.mutation(api.syncCursors.deleteSyncCursor, {
        platform: "slack",
        workspaceId: "T12345678",
      });

      expect(result).toBe(true);
    });

    it("doesn't delete cursor with different workspaceId", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor with workspace
      const cursorId = await t.run(async (ctx) => {
        return ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      const result = await asUser.mutation(api.syncCursors.deleteSyncCursor, {
        platform: "slack",
        workspaceId: "T99999999", // Different workspace
      });

      expect(result).toBe(false);

      // Original cursor should still exist
      const cursor = await t.run(async (ctx) => {
        return ctx.db.get(cursorId);
      });

      expect(cursor).not.toBeNull();
    });
  });

  // ============================================================================
  // resetAllSyncCursors Tests
  // ============================================================================
  describe("resetAllSyncCursors", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.syncCursors.resetAllSyncCursors, {})
      ).rejects.toThrow("Unauthorized");
    });

    it("returns zero when no cursors exist", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(
        api.syncCursors.resetAllSyncCursors,
        {}
      );

      expect(result.deleted).toBe(0);
    });

    it("deletes all cursors for user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create multiple cursors
      await t.run(async (ctx) => {
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T87654321",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "full",
        });
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "slack",
          workspaceId: "T12345678",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      const result = await asUser.mutation(
        api.syncCursors.resetAllSyncCursors,
        {}
      );

      expect(result.deleted).toBe(3);

      // Verify all deleted
      const remaining = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(remaining).toHaveLength(0);
    });

    it("only deletes cursors for authenticated user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create cursor for another user
      const otherUserId = await t.run(async (ctx) => {
        return ctx.db.insert(
          "users",
          createTestUserData({ workosUserId: "other_user" })
        );
      });

      await t.run(async (ctx) => {
        // User's cursor
        await ctx.db.insert("syncCursors", {
          userId,
          platform: "imessage",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
        // Other user's cursor
        await ctx.db.insert("syncCursors", {
          userId: otherUserId,
          platform: "imessage",
          cursorData: {},
          lastSyncAt: Date.now(),
          syncMode: "incremental",
        });
      });

      await asUser.mutation(api.syncCursors.resetAllSyncCursors, {});

      // Other user's cursor should still exist
      const otherCursor = await t.run(async (ctx) => {
        return ctx.db
          .query("syncCursors")
          .withIndex("by_user_platform", (q) =>
            q.eq("userId", otherUserId).eq("platform", "imessage")
          )
          .first();
      });

      expect(otherCursor).not.toBeNull();
    });
  });
});

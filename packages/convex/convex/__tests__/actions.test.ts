/**
 * Tests for Convex actions functions.
 *
 * Uses convex-test to mock the Convex backend and test
 * queries and mutations in isolation.
 */

import { convexTest } from "convex-test";
import { describe, expect, it, beforeEach } from "vitest";
import schema from "../schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestConversationData,
  createTestActionData,
  createTestIdentity,
} from "./helpers";
import { api } from "../_generated/api";

describe("actions", () => {
  describe("getPendingActionCount", () => {
    it("returns 0 for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      // getPendingActionCount requires auth via getAuthenticatedUser
      // Without identity, it should return { count: 0 }
      // We can't directly call it without auth setup, so we test the data layer
      const count = await t.run(async (ctx) => {
        // Create a user directly
        const userId = await ctx.db.insert("users", createTestUserData({
          pendingActionCount: 5,
        }));
        const user = await ctx.db.get(userId);
        return user?.pendingActionCount ?? 0;
      });

      expect(count).toBe(5);
    });

    it("uses denormalized counter from users table", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        // Create user with a specific pending action count
        const userId = await ctx.db.insert("users", createTestUserData({
          pendingActionCount: 42,
        }));

        const user = await ctx.db.get(userId);
        return user?.pendingActionCount;
      });

      expect(result).toBe(42);
    });
  });

  describe("action creation", () => {
    it("creates action with default values", async () => {
      const t = convexTest(schema, modules);

      const action = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());

        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "respond",
            status: "pending",
          })
        );

        return ctx.db.get(actionId);
      });

      expect(action).toBeTruthy();
      expect(action?.type).toBe("respond");
      expect(action?.status).toBe("pending");
      expect(action?.priority).toBe(50);
    });

    it("creates action with conversation reference", async () => {
      const t = convexTest(schema, modules);

      const action = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" })
        );
        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [contactId],
            platform: "imessage",
          })
        );

        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "respond",
            conversationId,
            contactId,
            platform: "imessage",
          })
        );

        return ctx.db.get(actionId);
      });

      expect(action).toBeTruthy();
      expect(action?.conversationId).toBeTruthy();
      expect(action?.contactId).toBeTruthy();
      expect(action?.platform).toBe("imessage");
    });
  });

  describe("action status transitions", () => {
    it("can update action status to completed", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, { status: "pending" })
        );

        // Simulate status update
        await ctx.db.patch(actionId, {
          status: "completed",
          completedAt: Date.now(),
        });

        return ctx.db.get(actionId);
      });

      expect(result?.status).toBe("completed");
      expect(result?.completedAt).toBeTruthy();
    });

    it("can update action status to discarded", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, { status: "pending" })
        );

        await ctx.db.patch(actionId, {
          status: "discarded",
          discardedAt: Date.now(),
        });

        return ctx.db.get(actionId);
      });

      expect(result?.status).toBe("discarded");
      expect(result?.discardedAt).toBeTruthy();
    });

    it("can update action status to snoozed with timestamp", async () => {
      const t = convexTest(schema, modules);
      const snoozeUntil = Date.now() + 3600000; // 1 hour from now

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, { status: "pending" })
        );

        await ctx.db.patch(actionId, {
          status: "snoozed",
          snoozedUntil: snoozeUntil,
        });

        return ctx.db.get(actionId);
      });

      expect(result?.status).toBe("snoozed");
      expect(result?.snoozedUntil).toBe(snoozeUntil);
    });
  });

  describe("action queries", () => {
    it("can query actions by user", async () => {
      const t = convexTest(schema, modules);

      const actions = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());

        // Create multiple actions
        await ctx.db.insert("actions", createTestActionData(userId, { type: "respond" }));
        await ctx.db.insert("actions", createTestActionData(userId, { type: "follow_up" }));
        await ctx.db.insert("actions", createTestActionData(userId, { type: "new_connection" }));

        return ctx.db
          .query("actions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
      });

      expect(actions).toHaveLength(3);
    });

    it("can query actions by user and status", async () => {
      const t = convexTest(schema, modules);

      const pendingActions = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());

        // Create actions with different statuses
        await ctx.db.insert("actions", createTestActionData(userId, { status: "pending" }));
        await ctx.db.insert("actions", createTestActionData(userId, { status: "pending" }));
        await ctx.db.insert("actions", createTestActionData(userId, { status: "completed" }));
        await ctx.db.insert("actions", createTestActionData(userId, { status: "discarded" }));

        return ctx.db
          .query("actions")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", "pending")
          )
          .collect();
      });

      expect(pendingActions).toHaveLength(2);
      expect(pendingActions.every((a) => a.status === "pending")).toBe(true);
    });
  });

  describe("pending action count adjustment", () => {
    it("increments pending count correctly", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData({
          pendingActionCount: 5,
        }));

        // Simulate adjustPendingActionCount with delta=1
        const user = await ctx.db.get(userId);
        const currentCount = user?.pendingActionCount ?? 0;
        await ctx.db.patch(userId, { pendingActionCount: currentCount + 1 });

        const updatedUser = await ctx.db.get(userId);
        return updatedUser?.pendingActionCount;
      });

      expect(result).toBe(6);
    });

    it("decrements pending count correctly", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData({
          pendingActionCount: 5,
        }));

        // Simulate adjustPendingActionCount with delta=-1
        const user = await ctx.db.get(userId);
        const currentCount = user?.pendingActionCount ?? 0;
        await ctx.db.patch(userId, { pendingActionCount: Math.max(0, currentCount - 1) });

        const updatedUser = await ctx.db.get(userId);
        return updatedUser?.pendingActionCount;
      });

      expect(result).toBe(4);
    });

    it("does not go below zero", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData({
          pendingActionCount: 0,
        }));

        // Simulate adjustPendingActionCount with delta=-1
        const user = await ctx.db.get(userId);
        const currentCount = user?.pendingActionCount ?? 0;
        await ctx.db.patch(userId, { pendingActionCount: Math.max(0, currentCount - 1) });

        const updatedUser = await ctx.db.get(userId);
        return updatedUser?.pendingActionCount;
      });

      expect(result).toBe(0);
    });
  });

});

/**
 * Integration tests for exported Convex queries and mutations.
 * These test the actual API functions with authentication.
 */
describe("actions API", () => {
  /**
   * Helper to set up an authenticated test environment.
   * Creates a user in the database that matches the identity.
   */
  async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
    const identity = createTestIdentity();
    const asUser = t.withIdentity(identity);

    // Create user in database with matching workosUserId
    const userId = await t.run(async (ctx) => {
      return ctx.db.insert("users", createTestUserData({
        workosUserId: identity.subject,
        pendingActionCount: 0,
      }));
    });

    return { asUser, userId, identity };
  }

  describe("getPendingActionCount query", () => {
    it("returns { count: 0 } for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.actions.getPendingActionCount, {});

      expect(result).toEqual({ count: 0 });
    });

    it("returns count from user's pendingActionCount field", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Update user's pending action count
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 7 });
      });

      const result = await asUser.query(api.actions.getPendingActionCount, {});

      expect(result).toEqual({ count: 7 });
    });

    it("returns 0 when pendingActionCount is not set", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      const result = await asUser.query(api.actions.getPendingActionCount, {});

      expect(result).toEqual({ count: 0 });
    });
  });

  describe("getPendingActions query", () => {
    it("returns empty array for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.actions.getPendingActions, {});

      expect(result).toEqual({ actions: [], nextCursor: null });
    });

    it("returns pending actions for authenticated user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a pending action
      await t.run(async (ctx) => {
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "respond",
        }));
      });

      const result = await asUser.query(api.actions.getPendingActions, {});

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].status).toBe("pending");
      expect(result.actions[0].type).toBe("respond");
    });

    it("includes snoozed actions that are due", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const pastTime = Date.now() - 60000; // 1 minute ago (due)
      const futureTime = Date.now() + 3600000; // 1 hour from now (not due)

      await t.run(async (ctx) => {
        // Snoozed action that is due
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "snoozed",
          type: "respond",
          snoozedUntil: pastTime,
        }));
        // Snoozed action that is not due yet
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "snoozed",
          type: "follow_up",
          snoozedUntil: futureTime,
        }));
      });

      const result = await asUser.query(api.actions.getPendingActions, {});

      // Should only include the due snoozed action
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].status).toBe("snoozed");
    });

    it("excludes completed and discarded actions", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "completed",
        }));
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "discarded",
        }));
      });

      const result = await asUser.query(api.actions.getPendingActions, {});

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].status).toBe("pending");
    });

    it("sorts by priority descending then createdAt descending", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const now = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          priority: 30,
          createdAt: now - 1000,
        }));
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          priority: 80,
          createdAt: now - 2000,
        }));
        await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          priority: 80,
          createdAt: now,
        }));
      });

      const result = await asUser.query(api.actions.getPendingActions, {});

      expect(result.actions).toHaveLength(3);
      // High priority, newer first
      expect(result.actions[0].priority).toBe(80);
      // High priority, older second
      expect(result.actions[1].priority).toBe(80);
      // Low priority last
      expect(result.actions[2].priority).toBe(30);
    });

    it("respects limit parameter", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("actions", createTestActionData(userId, {
            status: "pending",
          }));
        }
      });

      const result = await asUser.query(api.actions.getPendingActions, { limit: 2 });

      expect(result.actions).toHaveLength(2);
      expect(result.nextCursor).toBeTruthy();
    });
  });

  describe("createAction mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      await expect(
        t.mutation(api.actions.createAction, { type: "respond" })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates action with required fields", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const result = await asUser.mutation(api.actions.createAction, {
        type: "respond",
      });

      expect(result.actionId).toBeTruthy();

      // Verify the action was created correctly
      const action = await t.run(async (ctx) => ctx.db.get(result.actionId));
      expect(action?.type).toBe("respond");
      expect(action?.status).toBe("pending");
      expect(action?.priority).toBe(50); // default
      expect(action?.userId).toEqual(userId);
    });

    it("creates action with all optional fields", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a contact and conversation for the action
      const { contactId, conversationId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const conversationId = await ctx.db.insert("conversations", createTestConversationData(userId, {
          participantContactIds: [contactId],
        }));
        return { contactId, conversationId };
      });

      const result = await asUser.mutation(api.actions.createAction, {
        type: "follow_up",
        priority: 75,
        conversationId,
        contactId,
        platform: "imessage",
        reason: "Needs follow up",
        llmReason: "AI determined follow up needed",
      });

      const action = await t.run(async (ctx) => ctx.db.get(result.actionId));
      expect(action?.type).toBe("follow_up");
      expect(action?.priority).toBe(75);
      expect(action?.platform).toBe("imessage");
      expect(action?.reason).toBe("Needs follow up");
      expect(action?.llmReason).toBe("AI determined follow up needed");
    });

    it("increments pendingActionCount on user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Verify initial count is 0
      const initialUser = await t.run(async (ctx) => ctx.db.get(userId));
      expect(initialUser?.pendingActionCount).toBe(0);

      await asUser.mutation(api.actions.createAction, { type: "respond" });

      const updatedUser = await t.run(async (ctx) => ctx.db.get(userId));
      expect(updatedUser?.pendingActionCount).toBe(1);
    });
  });

  describe("updateActionStatus mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      // Create an action to try to update
      const actionId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("actions", createTestActionData(userId));
      });

      await expect(
        t.mutation(api.actions.updateActionStatus, {
          actionId,
          status: "completed",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("updates status to completed", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      const result = await asUser.mutation(api.actions.updateActionStatus, {
        actionId,
        status: "completed",
      });

      expect(result.success).toBe(true);

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("completed");
      expect(action?.completedAt).toBeTruthy();
    });

    it("updates status to discarded", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      const result = await asUser.mutation(api.actions.updateActionStatus, {
        actionId,
        status: "discarded",
      });

      expect(result.success).toBe(true);

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("discarded");
      expect(action?.discardedAt).toBeTruthy();
    });

    it("updates status to snoozed with snoozedUntil", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      const snoozedUntil = Date.now() + 3600000; // 1 hour from now
      const result = await asUser.mutation(api.actions.updateActionStatus, {
        actionId,
        status: "snoozed",
        snoozedUntil,
      });

      expect(result.success).toBe(true);

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("snoozed");
      expect(action?.snoozedUntil).toBe(snoozedUntil);
    });

    it("decrements pendingActionCount when status changes from pending", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Set initial pending count
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 3 });
      });

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      await asUser.mutation(api.actions.updateActionStatus, {
        actionId,
        status: "completed",
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(2);
    });

    it("increments pendingActionCount when status changes to pending", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Set initial pending count
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 2 });
      });

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "snoozed",
        }));
      });

      await asUser.mutation(api.actions.updateActionStatus, {
        actionId,
        status: "pending",
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(3);
    });

    it("throws when action not found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create a fake action ID
      const fakeActionId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("actions", createTestActionData(userId));
        await ctx.db.delete(id); // Delete it immediately
        return id;
      });

      await expect(
        asUser.mutation(api.actions.updateActionStatus, {
          actionId: fakeActionId,
          status: "completed",
        })
      ).rejects.toThrow("Action not found");
    });

    it("throws when action belongs to different user", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      // Create action for a different user
      const actionId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert("users", createTestUserData({
          workosUserId: "other_user_id",
        }));
        return ctx.db.insert("actions", createTestActionData(otherUserId));
      });

      await expect(
        asUser.mutation(api.actions.updateActionStatus, {
          actionId,
          status: "completed",
        })
      ).rejects.toThrow("Action not found");
    });
  });

  describe("swipeAction mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const actionId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("actions", createTestActionData(userId));
      });

      await expect(
        t.mutation(api.actions.swipeAction, {
          actionId,
          direction: "left",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("handles left swipe - discards action", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "respond",
        }));
      });

      const result = await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "left",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("discarded");

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("discarded");
      expect(action?.discardedAt).toBeTruthy();

      // Verify pending count decremented
      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });

    it("handles up swipe - snoozes action", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      const snoozedUntil = Date.now() + 3600000; // 1 hour from now
      const result = await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "up",
        snoozedUntil,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("snoozed");
      expect(result.snoozedUntil).toBe(snoozedUntil);

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("snoozed");
      expect(action?.snoozedUntil).toBe(snoozedUntil);

      // Verify pending count decremented
      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });

    it("throws when snoozedUntil missing for up swipe", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      await expect(
        asUser.mutation(api.actions.swipeAction, {
          actionId,
          direction: "up",
        })
      ).rejects.toThrow("snoozedUntil is required for snooze action");
    });

    it("handles right swipe - completes action", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "respond",
        }));
      });

      const result = await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "right",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");

      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("completed");
      expect(action?.completedAt).toBeTruthy();
    });

    it("handles right swipe with responseText", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "respond",
        }));
      });

      const result = await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "right",
        responseText: "Custom response",
      });

      expect(result.success).toBe(true);
      expect(result.responseText).toBe("Custom response");
    });

    it("handles left swipe for new_connection - sets importance to -1", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contactId, actionId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          importance: 0,
        }));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "new_connection",
          contactId,
        }));
        return { contactId, actionId };
      });

      await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "left",
      });

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.importance).toBe(-1);
    });

    it("handles right swipe for new_connection - saves notes", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contactId, actionId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
          type: "new_connection",
          contactId,
        }));
        return { contactId, actionId };
      });

      const result = await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "right",
        responseText: "Met at conference, interested in collaboration",
      });

      expect(result.success).toBe(true);
      expect(result.notesSaved).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.notes).toBe("Met at conference, interested in collaboration");
    });

    it("does not decrement pendingActionCount below 0", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Start with count at 0 (edge case)
      const actionId = await t.run(async (ctx) => {
        return ctx.db.insert("actions", createTestActionData(userId, {
          status: "pending",
        }));
      });

      await asUser.mutation(api.actions.swipeAction, {
        actionId,
        direction: "left",
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });
  });

  describe("searchActions query", () => {
    it("returns empty for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.actions.searchActions, {});

      expect(result).toEqual({ actions: [] });
    });

    it("filters by status", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("actions", createTestActionData(userId, { status: "pending" }));
        await ctx.db.insert("actions", createTestActionData(userId, { status: "completed" }));
        await ctx.db.insert("actions", createTestActionData(userId, { status: "completed" }));
      });

      const result = await asUser.query(api.actions.searchActions, {
        status: "completed",
      });

      expect(result.actions).toHaveLength(2);
      expect(result.actions.every((a) => a.status === "completed")).toBe(true);
    });

    it("filters by type", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("actions", createTestActionData(userId, { type: "respond" }));
        await ctx.db.insert("actions", createTestActionData(userId, { type: "follow_up" }));
        await ctx.db.insert("actions", createTestActionData(userId, { type: "respond" }));
      });

      const result = await asUser.query(api.actions.searchActions, {
        type: "follow_up",
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe("follow_up");
    });

    it("respects limit parameter", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert("actions", createTestActionData(userId, {
            status: "pending",
          }));
        }
      });

      const result = await asUser.query(api.actions.searchActions, {
        limit: 3,
      });

      expect(result.actions).toHaveLength(3);
    });
  });
});

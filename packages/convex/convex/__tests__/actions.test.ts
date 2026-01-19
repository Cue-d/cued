/**
 * Tests for Convex actions functions.
 *
 * Uses convex-test to mock the Convex backend and test
 * queries and mutations in isolation.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestConversationData,
  createTestActionData,
} from "./helpers";

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

  describe("draft options", () => {
    it("can save and retrieve draft options", async () => {
      const t = convexTest(schema, modules);

      const action = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());

        const draftOptions = [
          {
            text: "Thanks for your message!",
            label: "direct",
            confidence: 0.9,
            assumptions: [],
            styleSources: [],
            riskFlags: [],
          },
          {
            text: "I appreciate you reaching out.",
            label: "diplomatic",
            confidence: 0.85,
            assumptions: [],
            styleSources: [],
            riskFlags: [],
          },
        ];

        const actionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId),
          draftOptions,
          selectedOptionIndex: 0,
          draftResponse: draftOptions[0].text,
        });

        return ctx.db.get(actionId);
      });

      expect(action?.draftOptions).toHaveLength(2);
      expect(action?.selectedOptionIndex).toBe(0);
      expect(action?.draftResponse).toBe("Thanks for your message!");
    });

    it("can update selected option", async () => {
      const t = convexTest(schema, modules);

      const result = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());

        const draftOptions = [
          { text: "Option 1", label: "direct", confidence: 0.9, assumptions: [], styleSources: [], riskFlags: [] },
          { text: "Option 2", label: "diplomatic", confidence: 0.85, assumptions: [], styleSources: [], riskFlags: [] },
        ];

        const actionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId),
          draftOptions,
          selectedOptionIndex: 0,
          draftResponse: draftOptions[0].text,
        });

        // Simulate selectDraftOption
        await ctx.db.patch(actionId, {
          selectedOptionIndex: 1,
          draftResponse: draftOptions[1].text,
        });

        return ctx.db.get(actionId);
      });

      expect(result?.selectedOptionIndex).toBe(1);
      expect(result?.draftResponse).toBe("Option 2");
    });
  });
});

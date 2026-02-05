/**
 * Tests for contact resolution and duplicate detection.
 *
 * Tests the batch duplicate detection pipeline (findDuplicateCandidatesInternal).
 * Contact resolution is now manual-only via triggerMergeScan.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestContactHandleData,
  createTestIdentity,
} from "./helpers.util";
import { internal } from "../convex/_generated/api";

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
        pendingActionCount: 0,
      })
    );
  });

  return { asUser, userId, identity };
}

describe("contactResolution", () => {
  describe("findDuplicateCandidatesInternal - Handle-based duplicate detection", () => {
    it("matches contacts with identical email addresses", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      // Create two contacts with same email
      const [contact1Id, contact2Id] = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Johnny D" })
        );

        // Add same email to both
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "gmail",
          })
        );

        return [c1, c2];
      });

      // Run duplicate scan
      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].confidence).toBe(1.0);
      expect(result.duplicatePairs[0].source).toBe("email_match");
      expect(
        [result.duplicatePairs[0].contact1Id, result.duplicatePairs[0].contact2Id].sort()
      ).toEqual([contact1Id, contact2Id].sort());
    });

    it("matches contacts with identical phone numbers", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane Doe" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane D" })
        );

        // Add phone with same value
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].confidence).toBe(1.0);
      expect(result.duplicatePairs[0].source).toBe("phone_match");
    });

    it("returns no match for different handles", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Alice" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Bob" })
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "bob@example.com",
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("matches email-like displayName as fallback", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Contact 1 has email as displayName
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "john@example.com" })
        );
        // Contact 2 has same email as handle
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" })
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("email_match");
    });

    it("matches phone-like displayName as fallback", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Contact 1 has phone as displayName
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "555-123-4567" })
        );
        // Contact 2 has same phone as handle (normalized)
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" })
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "phone",
            handle: "5551234567",
            platform: "imessage",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("phone_match");
    });

    it("handles multiple contacts with same shared handle", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person 1" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person 2" })
        );
        const c3 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person 3" })
        );

        // All three have the same email
        const sharedEmail = "shared@example.com";
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: sharedEmail,
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: sharedEmail,
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c3, {
            handleType: "email",
            handle: sharedEmail,
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Should find 3 pairs: (c1,c2), (c1,c3), (c2,c3)
      expect(result.duplicatePairs).toHaveLength(3);
      result.duplicatePairs.forEach((d) => {
        expect(d.source).toBe("email_match");
        expect(d.confidence).toBe(1.0);
      });
    });
  });

  describe("findDuplicateCandidatesInternal - Name-based duplicate detection", () => {
    it("matches contacts with identical display names (exact name match)", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [contact1Id, contact2Id] = await t.run(async (ctx) => {
        // Two contacts with identical names but different handles
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" })
        );

        // Different emails so they won't match by handle
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john.work@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john.personal@example.com",
            platform: "gmail",
          })
        );

        return [c1, c2];
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Exact name match (score >= 0.95) goes to duplicatePairs
      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("exact_name_match");
      expect(result.duplicatePairs[0].confidence).toBeGreaterThanOrEqual(0.95);
      expect(
        [result.duplicatePairs[0].contact1Id, result.duplicatePairs[0].contact2Id].sort()
      ).toEqual([contact1Id, contact2Id].sort());
    });

    it("detects fuzzy name matches with similar names", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Two contacts with similar but not identical names
        // Using names with high Jaro-Winkler similarity (0.60-0.95 range)
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Michael Johnson" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Micheal Johnson" }) // common misspelling
        );

        // Different emails
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "michael@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "micheal@example.com",
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Names with misspellings should match as fuzzy or exact depending on score
      // "Michael Johnson" vs "Micheal Johnson" should have high similarity
      const allMatches = [...result.duplicatePairs, ...result.fuzzyPairs];
      expect(allMatches.length).toBeGreaterThanOrEqual(1);
      const match = allMatches[0];
      expect(["exact_name_match", "fuzzy_name_match"]).toContain(match.source);
      expect(match.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("does not match dissimilar names", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Two contacts with completely different names
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Alice Johnson" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Robert Williams" })
        );

        // Different emails
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "robert@example.com",
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // No name-based matches for dissimilar names
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("excludes dismissed contacts from name matching", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Regular contact
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" })
        );
        // Dismissed contact with same name - insert directly to set isDismissed
        await ctx.db.insert("contacts", {
          userId,
          displayName: "John Smith",
          isDismissed: true,
        });
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Dismissed contact should be excluded from name matching
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("excludes email-like displayNames from name matching", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Contact with email as displayName (placeholder)
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "john@example.com" })
        );
        // Another contact with similar email as displayName
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "john@company.com" })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Email-like names should not trigger name matching (only handle matching)
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("does not duplicate suggestions for contacts already matched by handle", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Two contacts with same name AND same email
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" })
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" })
        );

        // Same email on both
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john@example.com",
            platform: "gmail",
          })
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "gmail",
          })
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId }
      );

      // Should only get 1 pair (email_match), not 2 (email + name)
      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("email_match");
      expect(result.fuzzyPairs).toHaveLength(0);
    });
  });
});

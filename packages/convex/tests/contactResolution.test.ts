/**
 * Tests for contact resolution and duplicate detection.
 *
 * Covers both manual full-scan and event-driven targeted merge checks.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestContactHandleData,
  createTestActionData,
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
      }),
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
          createTestContactData(userId, { displayName: "John Doe" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Johnny D" }),
        );

        // Add same email to both
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );

        return [c1, c2];
      });

      // Run duplicate scan
      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].confidence).toBe(1.0);
      expect(result.duplicatePairs[0].source).toBe("email_match");
      expect(
        [
          result.duplicatePairs[0].contact1Id,
          result.duplicatePairs[0].contact2Id,
        ].sort(),
      ).toEqual([contact1Id, contact2Id].sort());
    });

    it("matches contacts with identical phone numbers", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane Doe" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane D" }),
        );

        // Add phone with same value
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "Alice" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Bob" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "bob@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "john@example.com" }),
        );
        // Contact 2 has same email as handle
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "555-123-4567" }),
        );
        // Contact 2 has same phone as handle (normalized)
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Doe" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "phone",
            handle: "5551234567",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "Person 1" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person 2" }),
        );
        const c3 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person 3" }),
        );

        // All three have the same email
        const sharedEmail = "shared@example.com";
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: sharedEmail,
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: sharedEmail,
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c3, {
            handleType: "email",
            handle: sharedEmail,
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "John Smith" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" }),
        );

        // Different emails so they won't match by handle
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john.work@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john.personal@example.com",
            platform: "imessage",
          }),
        );

        return [c1, c2];
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Exact name match (score >= 0.95) goes to duplicatePairs
      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("exact_name_match");
      expect(result.duplicatePairs[0].confidence).toBeGreaterThanOrEqual(0.95);
      expect(
        [
          result.duplicatePairs[0].contact1Id,
          result.duplicatePairs[0].contact2Id,
        ].sort(),
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
          createTestContactData(userId, { displayName: "Michael Johnson" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Micheal Johnson" }), // common misspelling
        );

        // Different emails
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "michael@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "micheal@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "Alice Johnson" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Robert Williams" }),
        );

        // Different emails
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "robert@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
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
          createTestContactData(userId, { displayName: "John Smith" }),
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
        { userId },
      );

      // Dismissed contact should be excluded from name matching
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("excludes URN displayNames from name matching", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Contact with LinkedIn URN as displayName (placeholder)
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName:
              "urn:li:msg_messagingparticipant:urn:li:fsd_profile:ABC123",
          }),
        );
        // Another contact with similar URN tokens
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "urn:li:member:ABC123",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // URN-like names should not trigger name matching
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("detects conflicting linkedin_handle values", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Soham Bafana" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Soham Bafana" }),
        );

        // Different LinkedIn handles = different people
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "linkedin_handle",
            handle: "soham-bafana",
            platform: "linkedin",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "linkedin_handle",
            handle: "different-soham",
            platform: "linkedin",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Same name but different LinkedIn handles = conflict, should not match
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("detects conflicting slack_id values", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Anya" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Anya" }),
        );

        // Different Slack user IDs = different people
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "slack_id",
            handle: "U09CJ1JG5J6",
            platform: "slack",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "slack_id",
            handle: "U02E46S2NJC",
            platform: "slack",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Same name but different Slack IDs = conflict, should not match
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("detects conflicting twitter_handle values", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Alex Johnson" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Alex Johnson" }),
        );

        // Different Twitter handles = different people
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "twitter_handle",
            handle: "alexj_dev",
            platform: "twitter",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "twitter_handle",
            handle: "alex_johnson",
            platform: "twitter",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Same name but different Twitter handles = conflict, should not match
      expect(result.duplicatePairs).toHaveLength(0);
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("excludes contacts with no handles from name matching", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "theotarr" }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "theotarr" }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Handleless contacts should not generate name-based merge suggestions
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
          createTestContactData(userId, { displayName: "john@example.com" }),
        );
        // Another contact with similar email as displayName
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "john@company.com" }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Email-like names should not trigger name matching (only handle matching)
      expect(result.fuzzyPairs).toHaveLength(0);
    });

    it("matches contacts with different LinkedIn URN formats for same member ID", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [contact1Id, contact2Id] = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Soham Bafana" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Soham B" }),
        );

        // Contact 1 has a fsd_profile URN (normalizes to urn:li:member:abc123)
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "linkedin_urn",
            handle: "urn:li:fsd_profile:abc123",
            platform: "linkedin",
          }),
        );
        // Contact 2 has the canonical member URN format for the same ID
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "linkedin_urn",
            handle: "urn:li:member:abc123",
            platform: "linkedin",
          }),
        );

        return [c1, c2];
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].confidence).toBe(1.0);
      expect(result.duplicatePairs[0].source).toBe("linkedin_urn_match");
      expect(
        [
          result.duplicatePairs[0].contact1Id,
          result.duplicatePairs[0].contact2Id,
        ].sort(),
      ).toEqual([contact1Id, contact2Id].sort());
    });

    it("does not match contacts with different LinkedIn member IDs", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person A" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Person B" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "linkedin_urn",
            handle: "urn:li:member:abc123",
            platform: "linkedin",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "linkedin_urn",
            handle: "urn:li:member:xyz789",
            platform: "linkedin",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      expect(result.duplicatePairs).toHaveLength(0);
    });

    it("does not duplicate suggestions for contacts already matched by handle", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Two contacts with same name AND same email
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Smith" }),
        );

        // Same email on both
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId },
      );

      // Should only get 1 pair (email_match), not 2 (email + name)
      expect(result.duplicatePairs).toHaveLength(1);
      expect(result.duplicatePairs[0].source).toBe("email_match");
      expect(result.fuzzyPairs).toHaveLength(0);
    });
  });

  describe("event-driven targeted merge checks", () => {
    it("findDuplicateCandidatesInternal only returns pairs for the target contact", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [contact1Id, contact2Id, contact3Id] = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John One" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "John Two" }),
        );
        const c3 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane Three" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "shared@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "shared@example.com",
            platform: "imessage",
          }),
        );

        return [c1, c2, c3];
      });

      const targetResult = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId, contactId: contact1Id },
      );

      expect(targetResult.duplicatePairs).toHaveLength(1);
      expect(targetResult.duplicatePairs[0].source).toBe("email_match");
      expect(
        [
          targetResult.duplicatePairs[0].contact1Id,
          targetResult.duplicatePairs[0].contact2Id,
        ].sort(),
      ).toEqual([contact1Id, contact2Id].sort());

      const unrelatedResult = await t.query(
        internal.contactResolution.findDuplicateCandidatesInternal,
        { userId, contactId: contact3Id },
      );
      expect(unrelatedResult.duplicatePairs).toHaveLength(0);
      expect(unrelatedResult.fuzzyPairs).toHaveLength(0);
    });

    it("checkMergesForContact auto-merges deterministic email matches", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [contact1Id, contact2Id] = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "john@example.com" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John Doe",
            company: "Acme",
          }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "john@example.com",
            platform: "imessage",
          }),
        );

        return [c1, c2];
      });

      const actionResult = await t.action(
        internal.contactResolution.checkMergesForContact,
        { userId, contactId: contact1Id },
      );

      expect(actionResult.suggestionsCreated).toBe(0);
      expect(actionResult.errors).toEqual([]);

      await t.run(async (ctx) => {
        const contacts = await ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
        expect(contacts).toHaveLength(1);

        const approvedMerges = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", "approved"),
          )
          .collect();
        expect(approvedMerges).toHaveLength(1);
        expect(approvedMerges[0].source).toBe("email_match");

        const c1 = await ctx.db.get(contact1Id);
        const c2 = await ctx.db.get(contact2Id);
        expect(c1 === null || c2 === null).toBe(true);
      });
    });

    it("checkMergesForContact keeps exact name matches as suggestions", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [contact1Id, contact2Id] = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Taylor Smith" }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Taylor Smith" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c1, {
            handleType: "email",
            handle: "taylor.work@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "taylor.personal@example.com",
            platform: "imessage",
          }),
        );

        return [c1, c2];
      });

      const actionResult = await t.action(
        internal.contactResolution.checkMergesForContact,
        { userId, contactId: contact1Id },
      );
      expect(actionResult.errors).toEqual([]);
      expect(actionResult.suggestionsCreated).toBe(1);

      await t.run(async (ctx) => {
        const c1 = await ctx.db.get(contact1Id);
        const c2 = await ctx.db.get(contact2Id);
        expect(c1).not.toBeNull();
        expect(c2).not.toBeNull();

        const pendingSuggestions = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", "pending"),
          )
          .collect();
        expect(pendingSuggestions).toHaveLength(1);
        expect(pendingSuggestions[0].source).toBe("exact_name_match");
      });
    });
  });

  describe("autoMergeContacts", () => {
    it("keeps the higher-quality contact as primary even if args order is reversed", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [placeholderId, richId] = await t.run(async (ctx) => {
        const placeholder = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "urn:li:member:abc123",
          }),
        );
        const rich = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Jane Doe",
            company: "Acme",
            notes: "Met at conference",
          }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, placeholder, {
            handleType: "linkedin_urn",
            handle: "urn:li:member:abc123",
            platform: "linkedin",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, rich, {
            handleType: "linkedin_urn",
            handle: "urn:li:msg_messagingparticipant:urn:li:fsd_profile:abc123",
            platform: "linkedin",
          }),
        );

        return [placeholder, rich];
      });

      await t.mutation(internal.contactResolution.autoMergeContacts, {
        primaryContactId: placeholderId,
        secondaryContactId: richId,
        source: "linkedin_urn_match",
        reasoning: "test",
      });

      await t.run(async (ctx) => {
        const placeholder = await ctx.db.get(placeholderId);
        const rich = await ctx.db.get(richId);

        expect(placeholder).toBeNull();
        expect(rich).not.toBeNull();
        expect(rich?.displayName).toBe("Jane Doe");
      });
    });

    it("deduplicates equivalent linkedin_urn handles during merge", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const [primaryId, secondaryId] = await t.run(async (ctx) => {
        const primary = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Jane Doe",
            company: "Acme",
          }),
        );
        const secondary = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Jane D" }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, primary, {
            handleType: "linkedin_urn",
            handle: "urn:li:member:abc123",
            platform: "linkedin",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondary, {
            handleType: "linkedin_urn",
            handle: "urn:li:msg_messagingparticipant:urn:li:fsd_profile:abc123",
            platform: "linkedin",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondary, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );

        return [primary, secondary];
      });

      await t.mutation(internal.contactResolution.autoMergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
        source: "linkedin_urn_match",
        reasoning: "test",
      });

      await t.run(async (ctx) => {
        const mergedHandles = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryId))
          .collect();

        const linkedInUrnHandles = mergedHandles.filter(
          (h) => h.handleType === "linkedin_urn",
        );
        const phoneHandles = mergedHandles.filter(
          (h) => h.handleType === "phone",
        );

        expect(linkedInUrnHandles).toHaveLength(1);
        expect(linkedInUrnHandles[0].handle).toBe("urn:li:member:abc123");
        expect(phoneHandles).toHaveLength(1);
      });
    });

    it("resolves pending merge work that references the secondary contact", async () => {
      const t = convexTest(schema, modules);
      const { userId } = await setupAuthenticatedUser(t);

      const {
        primaryId,
        secondaryId,
        otherId,
        pairSuggestionId,
        unrelatedSuggestionId,
        pairActionId,
        unrelatedActionId,
        followUpActionId,
      } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Jane Doe",
            company: "Acme",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "jane@example.com",
          }),
        );
        const otherId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Another Person",
          }),
        );

        await ctx.db.patch(userId, { pendingActionCount: 2 });

        const pairSuggestionId = await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: primaryId,
          contact2Id: secondaryId,
          confidence: 0.99,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });

        const unrelatedSuggestionId = await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: otherId,
          contact2Id: secondaryId,
          confidence: 0.72,
          source: "fuzzy_name_match",
          status: "pending",
          createdAt: Date.now(),
        });

        const pairActionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId, {
            type: "resolve_contact",
            status: "pending",
            contactId: secondaryId,
          }),
          secondaryContactId: primaryId,
          mergeSuggestionId: pairSuggestionId,
        });

        const unrelatedActionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId, {
            type: "resolve_contact",
            status: "pending",
            contactId: otherId,
          }),
          secondaryContactId: secondaryId,
          mergeSuggestionId: unrelatedSuggestionId,
        });

        const followUpActionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "follow_up",
            status: "pending",
            contactId: secondaryId,
          }),
        );

        return {
          primaryId,
          secondaryId,
          otherId,
          pairSuggestionId,
          unrelatedSuggestionId,
          pairActionId,
          unrelatedActionId,
          followUpActionId,
        };
      });

      await t.mutation(internal.contactResolution.autoMergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
        source: "email_match",
        reasoning: "deterministic handle match",
      });

      await t.run(async (ctx) => {
        expect(await ctx.db.get(secondaryId)).toBeNull();
        expect(await ctx.db.get(otherId)).not.toBeNull();

        const pairSuggestion = await ctx.db.get(pairSuggestionId);
        const unrelatedSuggestion = await ctx.db.get(unrelatedSuggestionId);
        expect(pairSuggestion?.status).toBe("approved");
        expect(pairSuggestion?.resolvedAt).toBeDefined();
        expect(unrelatedSuggestion?.status).toBe("rejected");
        expect(unrelatedSuggestion?.resolvedAt).toBeDefined();

        const pairAction = await ctx.db.get(pairActionId);
        const unrelatedAction = await ctx.db.get(unrelatedActionId);
        expect(pairAction?.status).toBe("completed");
        expect(pairAction?.completedAt).toBeDefined();
        expect(unrelatedAction?.status).toBe("discarded");
        expect(unrelatedAction?.discardedAt).toBeDefined();

        const followUpAction = await ctx.db.get(followUpActionId);
        expect(followUpAction?.contactId).toBe(primaryId);

        const user = await ctx.db.get(userId);
        expect(user?.pendingActionCount).toBe(0);
      });
    });
  });
});

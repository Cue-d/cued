/**
 * Tests for Convex contacts functions.
 *
 * Uses convex-test to mock the Convex backend and test
 * queries and mutations in isolation.
 */

import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import {
  createTestUserData,
  createTestContactData,
  createTestContactHandleData,
  createTestConversationData,
  createTestMessageData,
  createTestActionData,
  createTestIdentity,
} from "./helpers.util";
import { api } from "../convex/_generated/api";
import { useSchedulerCleanup } from "./schedulerCleanup.util";

const { trackTest } = useSchedulerCleanup();

/**
 * Helper to set up an authenticated test environment.
 * Creates a user in the database that matches the identity.
 */
async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const identity = createTestIdentity();
  const asUser = t.withIdentity(identity);

  // Create user in database with matching workosUserId
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

describe("contacts", () => {
  describe("getContacts query", () => {
    it("returns empty array for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.contacts.getContacts, {});

      expect(result).toEqual({ contacts: [], nextCursor: null });
    });

    it("returns contacts for authenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create contacts
      await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Smith",
          }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Bob Jones",
          }),
        );
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(2);
    });

    it("returns contacts sorted alphabetically by displayName", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Zara",
          }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice",
          }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Mike",
          }),
        );
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(3);
      expect(result.contacts[0].displayName).toBe("Alice");
      expect(result.contacts[1].displayName).toBe("Mike");
      expect(result.contacts[2].displayName).toBe("Zara");
    });

    it("includes handles for each contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Smith",
          }),
        );

        // Add multiple handles
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, contactId, {
            handleType: "phone",
            handle: "+15551234567",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, contactId, {
            handleType: "email",
            handle: "alice@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].handles).toHaveLength(2);
      expect(result.contacts[0].handles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "phone", value: "+15551234567" }),
          expect.objectContaining({
            type: "email",
            value: "alice@example.com",
          }),
        ]),
      );
    });

    it("excludes dismissed contacts", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Active Contact",
          }),
        );
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, {
            displayName: "Dismissed Contact",
          }),
          isDismissed: true,
        });
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].displayName).toBe("Active Contact");
    });

    it("paginates correctly with status filtering", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, { displayName: "A Dismissed" }),
          isDismissed: true,
        });
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "B Active" }),
        );
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, { displayName: "C Archived" }),
          status: "archived",
        });
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "D Active" }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "E Active" }),
        );
      });

      const page1 = await asUser.query(api.contacts.getContacts, {
        status: "active",
        limit: 2,
      });
      expect(page1.contacts.map((c) => c.displayName)).toEqual([
        "B Active",
        "D Active",
      ]);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await asUser.query(api.contacts.getContacts, {
        status: "active",
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.contacts.map((c) => c.displayName)).toEqual(["E Active"]);
      expect(page2.nextCursor).toBeNull();
    });

    it("supports cursor-based pagination", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Create 5 contacts
        for (const name of ["Alice", "Bob", "Carol", "David", "Eve"]) {
          await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: name,
            }),
          );
        }
      });

      // First page
      const page1 = await asUser.query(api.contacts.getContacts, { limit: 2 });
      expect(page1.contacts).toHaveLength(2);
      expect(page1.contacts[0].displayName).toBe("Alice");
      expect(page1.contacts[1].displayName).toBe("Bob");
      expect(page1.nextCursor).toBeTruthy();

      // Second page
      const page2 = await asUser.query(api.contacts.getContacts, {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.contacts).toHaveLength(2);
      expect(page2.contacts[0].displayName).toBe("Carol");
      expect(page2.contacts[1].displayName).toBe("David");

      // Third page (last)
      const page3 = await asUser.query(api.contacts.getContacts, {
        limit: 2,
        cursor: page2.nextCursor!,
      });
      expect(page3.contacts).toHaveLength(1);
      expect(page3.contacts[0].displayName).toBe("Eve");
      expect(page3.nextCursor).toBeNull();
    });

    it("supports search by displayName", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Smith",
          }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Bob Johnson",
          }),
        );
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Alice Cooper",
          }),
        );
      });

      const result = await asUser.query(api.contacts.getContacts, {
        searchQuery: "Alice",
      });

      expect(result.contacts).toHaveLength(2);
      expect(
        result.contacts.every((c) => c.displayName.includes("Alice")),
      ).toBe(true);
    });

    it("respects limit parameter", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: `Contact ${i}`,
            }),
          );
        }
      });

      const result = await asUser.query(api.contacts.getContacts, { limit: 3 });

      expect(result.contacts).toHaveLength(3);
      expect(result.nextCursor).toBeTruthy();
    });
  });

  describe("getContact query", () => {
    it("returns null for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      // Create a contact
      const contactId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("contacts", createTestContactData(userId));
      });

      const result = await t.query(api.contacts.getContact, { contactId });

      expect(result).toBeNull();
    });

    it("returns contact with handles for authenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John Doe",
            company: "Acme Corp",
            notes: "Met at conference",
          }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, contactId, {
            handleType: "phone",
            handle: "+15551234567",
          }),
        );

        return contactId;
      });

      const result = await asUser.query(api.contacts.getContact, { contactId });

      expect(result).toBeTruthy();
      expect(result?.displayName).toBe("John Doe");
      expect(result?.company).toBe("Acme Corp");
      expect(result?.notes).toBe("Met at conference");
      expect(result?.handles).toHaveLength(1);
      expect(result?.handles[0]).toEqual(
        expect.objectContaining({ type: "phone", value: "+15551234567" }),
      );
    });

    it("returns null for contact belonging to different user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      // Create contact for a different user
      const contactId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({
            workosUserId: "other_user_id",
          }),
        );
        return ctx.db.insert("contacts", createTestContactData(otherUserId));
      });

      const result = await asUser.query(api.contacts.getContact, { contactId });

      expect(result).toBeNull();
    });
  });

  describe("getAdjacentContacts query", () => {
    it("excludes archived and dismissed contacts", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const targetContactId = await t.run(async (ctx) => {
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Aaron Active" }),
        );
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, { displayName: "Beta Archived" }),
          status: "archived",
        });
        const targetContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Charlie Target" }),
        );
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, {
            displayName: "Delta Dismissed Status",
          }),
          status: "dismissed",
        });
        await ctx.db.insert("contacts", {
          ...createTestContactData(userId, {
            displayName: "Echo Legacy Dismissed",
          }),
          isDismissed: true,
        });
        await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Foxtrot Active" }),
        );
        return targetContactId;
      });

      const adjacent = await asUser.query(api.contacts.getAdjacentContacts, {
        contactId: targetContactId,
        count: 3,
      });

      expect(adjacent.before.map((c) => c.displayName)).toEqual(["Aaron Active"]);
      expect(adjacent.after.map((c) => c.displayName)).toEqual(["Foxtrot Active"]);
    });
  });

  describe("updateContact mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const contactId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("contacts", createTestContactData(userId));
      });

      await expect(
        t.mutation(api.contacts.updateContact, {
          contactId,
          displayName: "Updated Name",
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("updates contact displayName", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Original Name",
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.updateContact, {
        contactId,
        displayName: "Updated Name",
      });

      expect(result.success).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.displayName).toBe("Updated Name");
    });

    it("updates contact company", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John Doe",
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.updateContact, {
        contactId,
        company: "New Company",
      });

      expect(result.success).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.company).toBe("New Company");
    });

    it("updates contact notes", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", createTestContactData(userId));
      });

      const result = await asUser.mutation(api.contacts.updateContact, {
        contactId,
        notes: "New notes about this contact",
      });

      expect(result.success).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.notes).toBe("New notes about this contact");
    });

    it("updates contact importance", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            importance: 0,
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.updateContact, {
        contactId,
        importance: 5,
      });

      expect(result.success).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.importance).toBe(5);
    });

    it("updates contact tags", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            tags: ["old-tag"],
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.updateContact, {
        contactId,
        tags: ["new-tag-1", "new-tag-2"],
      });

      expect(result.success).toBe(true);

      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.tags).toEqual(["new-tag-1", "new-tag-2"]);
    });

    it("throws when contact not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create and delete a contact to get an invalid ID
      const fakeContactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        await ctx.db.delete(id);
        return id;
      });

      await expect(
        asUser.mutation(api.contacts.updateContact, {
          contactId: fakeContactId,
          displayName: "Test",
        }),
      ).rejects.toThrow("Contact not found");
    });

    it("throws when contact belongs to different user", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser } = await setupAuthenticatedUser(t);

      // Create contact for a different user
      const contactId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert(
          "users",
          createTestUserData({
            workosUserId: "other_user_id",
          }),
        );
        return ctx.db.insert("contacts", createTestContactData(otherUserId));
      });

      await expect(
        asUser.mutation(api.contacts.updateContact, {
          contactId,
          displayName: "Hacked",
        }),
      ).rejects.toThrow("Contact not found");
    });
  });

  describe("contact handle mutations", () => {
    it("addContactHandle normalizes values and triggers merge detection", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactA = await t.run(async (ctx) => {
        const c1 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Contact A",
          }),
        );
        const c2 = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Contact B",
          }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, c2, {
            handleType: "email",
            handle: "duplicate@example.com",
            platform: "imessage",
          }),
        );

        return c1;
      });

      const addResult = await asUser.mutation(api.contacts.addContactHandle, {
        contactId: contactA,
        handleType: "email",
        handle: "Duplicate@Example.com",
        platform: "imessage",
      });

      expect(addResult.success).toBe(true);
      expect(addResult.created).toBe(true);

      await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());

      await t.run(async (ctx) => {
        const contacts = await ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
        expect(contacts).toHaveLength(1);
      });
    });

    it("updateContactHandle updates and normalizes existing handle", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const handleId = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Handle Test",
          }),
        );

        return ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, contactId, {
            handleType: "phone",
            handle: "(555) 123-4567",
            platform: "imessage",
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.updateContactHandle, {
        handleId,
        handle: "+1 (555) 123-9999",
      });

      expect(result.success).toBe(true);
      expect(result.changed).toBe(true);

      const updated = await t.run(async (ctx) => ctx.db.get(handleId));
      expect(updated?.handle).toBe("+15551239999");
    });

    it("removeContactHandle deletes a handle", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const handleId = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Delete Handle Test",
          }),
        );

        return ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, contactId, {
            handleType: "email",
            handle: "delete.me@example.com",
            platform: "imessage",
          }),
        );
      });

      const result = await asUser.mutation(api.contacts.removeContactHandle, {
        handleId,
      });
      expect(result.success).toBe(true);

      const deleted = await t.run(async (ctx) => ctx.db.get(handleId));
      expect(deleted).toBeNull();
    });
  });

  describe("mergePreview query", () => {
    it("dedupes handles using normalized keys", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary Contact",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary Contact",
          }),
        );

        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, primaryId, {
            handleType: "email",
            handle: "shared@example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondaryId, {
            handleType: "email",
            handle: "Shared@Example.com",
            platform: "imessage",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondaryId, {
            handleType: "phone",
            handle: "+15551112222",
            platform: "imessage",
          }),
        );

        return { primaryId, secondaryId };
      });

      const preview = await asUser.query(api.contacts.mergePreview, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      expect(preview).not.toBeNull();
      expect(preview?.handlesToDedupe).toHaveLength(1);
      expect(preview?.handlesToDedupe[0]).toEqual(
        expect.objectContaining({
          type: "email",
          value: "Shared@Example.com",
        }),
      );
      expect(preview?.handlesToMove).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "phone",
            value: "+15551112222",
          }),
        ]),
      );
    });
  });

  describe("mergeContacts mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary",
          }),
        );
        return { primaryId, secondaryId };
      });

      await expect(
        t.mutation(api.contacts.mergeContacts, {
          primaryContactId: primaryId,
          secondaryContactId: secondaryId,
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("moves handles from secondary to primary contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary Contact",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary Contact",
          }),
        );

        // Add handles to both
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, primaryId, {
            handle: "+15551111111",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondaryId, {
            handle: "+15552222222",
          }),
        );
        await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondaryId, {
            handleType: "email",
            handle: "secondary@example.com",
            platform: "imessage",
          }),
        );

        return { primaryId, secondaryId };
      });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      expect(result.success).toBe(true);
      expect(result.handlesMovedCount).toBe(2);

      // Verify handles moved to primary
      const handles = await t.run(async (ctx) => {
        return ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryId))
          .collect();
      });
      expect(handles).toHaveLength(3);

      // Verify secondary contact deleted
      const secondary = await t.run(async (ctx) => ctx.db.get(secondaryId));
      expect(secondary).toBeNull();
    });

    it("updates conversations referencing secondary contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, conversationId } = await t.run(
        async (ctx) => {
          const primaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Primary",
            }),
          );
          const secondaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Secondary",
            }),
          );

          // Create conversation with secondary contact
          const conversationId = await ctx.db.insert(
            "conversations",
            createTestConversationData(userId, {
              participantContactIds: [secondaryId],
            }),
          );

          return { primaryId, secondaryId, conversationId };
        },
      );

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      expect(result.success).toBe(true);
      expect(result.conversationsUpdatedCount).toBe(1);

      // Verify conversation now references primary
      const conversation = await t.run(async (ctx) =>
        ctx.db.get(conversationId),
      );
      expect(conversation?.participantContactIds).toContain(primaryId);
      expect(conversation?.participantContactIds).not.toContain(secondaryId);
    });

    it("updates messages referencing secondary contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, messageId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary",
          }),
        );

        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId),
        );

        // Create message from secondary contact
        const messageId = await ctx.db.insert(
          "messages",
          createTestMessageData(userId, conversationId, {
            senderContactId: secondaryId,
            content: "Hello from secondary",
          }),
        );

        return { primaryId, secondaryId, messageId };
      });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      expect(result.success).toBe(true);
      expect(result.messagesUpdatedCount).toBe(1);

      // Verify message now references primary
      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message?.senderContactId).toEqual(primaryId);
    });

    it("repoints senderHandleId when deduping duplicate handles during merge", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, primaryHandleId, secondaryHandleId, messageId } =
        await t.run(async (ctx) => {
          const primaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary" }),
          );
          const secondaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary" }),
          );
          const primaryHandleId = await ctx.db.insert(
            "contactHandles",
            createTestContactHandleData(userId, primaryId, {
              handleType: "phone",
              handle: "+15551234567",
            }),
          );
          const secondaryHandleId = await ctx.db.insert(
            "contactHandles",
            createTestContactHandleData(userId, secondaryId, {
              handleType: "phone",
              handle: "+15551234567",
            }),
          );

          const conversationId = await ctx.db.insert(
            "conversations",
            createTestConversationData(userId, {
              participantContactIds: [secondaryId],
            }),
          );
          const messageId = await ctx.db.insert("messages", {
            ...createTestMessageData(userId, conversationId, {
              senderContactId: secondaryId,
            }),
            senderHandleId: secondaryHandleId,
          });

          return {
            primaryId,
            secondaryId,
            primaryHandleId,
            secondaryHandleId,
            messageId,
          };
        });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });
      expect(result.success).toBe(true);

      const { message, deletedSecondaryHandle } = await t.run(async (ctx) => ({
        message: await ctx.db.get(messageId),
        deletedSecondaryHandle: await ctx.db.get(secondaryHandleId),
      }));
      expect(message?.senderContactId).toEqual(primaryId);
      expect(message?.senderHandleId).toEqual(primaryHandleId);
      expect(deletedSecondaryHandle).toBeNull();
    });

    it("merges metadata - fills gaps from secondary", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary",
            company: undefined, // No company
            notes: "Primary notes",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary",
            company: "Secondary Co",
            notes: "Secondary notes",
          }),
        );

        return { primaryId, secondaryId };
      });

      await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      // Verify primary got company from secondary
      const primary = await t.run(async (ctx) => ctx.db.get(primaryId));
      expect(primary?.company).toBe("Secondary Co");
      // Verify primary kept its own notes
      expect(primary?.notes).toBe("Primary notes");
    });

    it("throws when primary contact not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeId, secondaryId } = await t.run(async (ctx) => {
        const fakeId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        await ctx.db.delete(fakeId);

        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        return { fakeId, secondaryId };
      });

      await expect(
        asUser.mutation(api.contacts.mergeContacts, {
          primaryContactId: fakeId,
          secondaryContactId: secondaryId,
        }),
      ).rejects.toThrow("Primary contact not found");
    });

    it("throws when secondary contact not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, fakeId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        const fakeId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        await ctx.db.delete(fakeId);

        return { primaryId, fakeId };
      });

      await expect(
        asUser.mutation(api.contacts.mergeContacts, {
          primaryContactId: primaryId,
          secondaryContactId: fakeId,
        }),
      ).rejects.toThrow("Secondary contact not found");
    });

    it("uses suggestionId to approve pending suggestion and resolve linked action", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, suggestionId, actionId } = await t.run(
        async (ctx) => {
          await ctx.db.patch(userId, { pendingActionCount: 1 });

          const primaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Primary",
            }),
          );
          const secondaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Secondary",
            }),
          );

          const suggestionId = await ctx.db.insert("mergeSuggestions", {
            userId,
            contact1Id: primaryId,
            contact2Id: secondaryId,
            confidence: 0.92,
            source: "email_match",
            status: "pending",
            createdAt: Date.now(),
          });

          const actionId = await ctx.db.insert("actions", {
            ...createTestActionData(userId, {
              type: "resolve_contact",
              status: "pending",
              contactId: primaryId,
            }),
            secondaryContactId: secondaryId,
            mergeSuggestionId: suggestionId,
          });

          return { primaryId, secondaryId, suggestionId, actionId };
        },
      );

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
        suggestionId,
      });
      expect(result.success).toBe(true);

      const { suggestion, action, user } = await t.run(async (ctx) => ({
        suggestion: await ctx.db.get(suggestionId),
        action: await ctx.db.get(actionId),
        user: await ctx.db.get(userId),
      }));

      expect(suggestion?.status).toBe("approved");
      expect(suggestion?.resolvedAt).toBeTypeOf("number");
      expect(action?.status).toBe("completed");
      expect(action?.completedAt).toBeTypeOf("number");
      expect(user?.pendingActionCount).toBe(0);
    });

    it("throws when suggestionId does not match merge pair", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, mismatchSuggestionId } = await t.run(
        async (ctx) => {
          const primaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Primary",
            }),
          );
          const secondaryId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Secondary",
            }),
          );
          const otherId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Other",
            }),
          );

          const mismatchSuggestionId = await ctx.db.insert("mergeSuggestions", {
            userId,
            contact1Id: primaryId,
            contact2Id: otherId,
            confidence: 0.66,
            source: "fuzzy_name_match",
            status: "pending",
            createdAt: Date.now(),
          });

          return { primaryId, secondaryId, mismatchSuggestionId };
        },
      );

      await expect(
        asUser.mutation(api.contacts.mergeContacts, {
          primaryContactId: primaryId,
          secondaryContactId: secondaryId,
          suggestionId: mismatchSuggestionId,
        }),
      ).rejects.toThrow("Merge suggestion does not match selected contacts");
    });

    it("stores compact merge audit details without messageIds payload", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Primary" }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Secondary" }),
        );
        return { primaryId, secondaryId };
      });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });
      expect(result.success).toBe(true);

      const mergeEntry = await t.run(async (ctx) =>
        ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .first(),
      );
      expect(mergeEntry).not.toBeNull();
      const details = mergeEntry?.details as { messageIds?: string[] } | undefined;
      expect(details?.messageIds).toBeUndefined();
    });

    it("schedules a follow-up merge scan for the surviving contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Primary" }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Secondary" }),
        );
        return { primaryId, secondaryId };
      });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });
      expect(result.success).toBe(true);

      const pendingScans = await t.run(async (ctx) => {
        const all = await ctx.db.system.query("_scheduled_functions").collect();
        return all.filter(
          (fn) =>
            fn.name.includes("scanAllContactsForMerges") &&
            fn.state.kind === "pending" &&
            (fn.args as { userId?: string }[])[0]?.userId === userId,
        );
      });
      expect(pendingScans).toHaveLength(1);
    });
  });

  describe("manualMerge mutation", () => {
    it("resolves pending resolve_contact actions and suggestions tied to merged secondary", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const {
        primaryId,
        secondaryId,
        pairSuggestionId,
        pairActionId,
        otherSuggestionId,
        otherActionId,
      } = await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 2 });

        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Primary",
          }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary",
          }),
        );
        const otherId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Other",
          }),
        );

        const pairSuggestionId = await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: primaryId,
          contact2Id: secondaryId,
          confidence: 0.95,
          source: "phone_match",
          status: "pending",
          createdAt: Date.now(),
        });

        const otherSuggestionId = await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: otherId,
          contact2Id: secondaryId,
          confidence: 0.6,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });

        const pairActionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId, {
            type: "resolve_contact",
            status: "pending",
            contactId: primaryId,
          }),
          secondaryContactId: secondaryId,
          mergeSuggestionId: pairSuggestionId,
        });

        const otherActionId = await ctx.db.insert("actions", {
          ...createTestActionData(userId, {
            type: "resolve_contact",
            status: "pending",
            contactId: otherId,
          }),
          secondaryContactId: secondaryId,
          mergeSuggestionId: otherSuggestionId,
        });

        return {
          primaryId,
          secondaryId,
          pairSuggestionId,
          pairActionId,
          otherSuggestionId,
          otherActionId,
        };
      });

      const result = await asUser.mutation(api.contacts.manualMerge, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });
      expect(result.success).toBe(true);

      const {
        pairSuggestion,
        otherSuggestion,
        pairAction,
        otherAction,
        user,
        secondaryContact,
      } = await t.run(async (ctx) => ({
        pairSuggestion: await ctx.db.get(pairSuggestionId),
        otherSuggestion: await ctx.db.get(otherSuggestionId),
        pairAction: await ctx.db.get(pairActionId),
        otherAction: await ctx.db.get(otherActionId),
        user: await ctx.db.get(userId),
        secondaryContact: await ctx.db.get(secondaryId),
      }));

      expect(pairSuggestion?.status).toBe("approved");
      expect(otherSuggestion?.status).toBe("rejected");
      expect(pairAction?.status).toBe("completed");
      expect(otherAction?.status).toBe("discarded");
      expect(user?.pendingActionCount).toBe(0);
      expect(secondaryContact).toBeNull();
    });

    it("schedules a follow-up merge scan for the surviving contact", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Primary" }),
        );
        const secondaryId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Secondary" }),
        );
        return { primaryId, secondaryId };
      });

      const result = await asUser.mutation(api.contacts.manualMerge, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });
      expect(result.success).toBe(true);

      const pendingScans = await t.run(async (ctx) => {
        const all = await ctx.db.system.query("_scheduled_functions").collect();
        return all.filter(
          (fn) =>
            fn.name.includes("scanAllContactsForMerges") &&
            fn.state.kind === "pending" &&
            (fn.args as { userId?: string }[])[0]?.userId === userId,
        );
      });
      expect(pendingScans).toHaveLength(1);
    });
  });

  describe("getPendingMergeSuggestions query", () => {
    it("returns empty for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(api.contacts.getPendingMergeSuggestions, {});

      expect(result).toEqual({ suggestions: [] });
    });

    it("returns pending merge suggestions with contact details", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John Doe",
          }),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John D",
          }),
        );

        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.85,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });
      });

      const result = await asUser.query(
        api.contacts.getPendingMergeSuggestions,
        {},
      );

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].confidence).toBe(0.85);
      expect(result.suggestions[0].contact1?.displayName).toBe("John Doe");
      expect(result.suggestions[0].contact2?.displayName).toBe("John D");
    });

    it("excludes approved and rejected suggestions", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact3Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact4Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        // Pending
        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "phone_match",
          status: "pending",
          createdAt: Date.now(),
        });

        // Approved
        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: contact3Id,
          contact2Id: contact4Id,
          confidence: 0.8,
          source: "email_match",
          status: "approved",
          createdAt: Date.now(),
        });

        // Rejected
        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: contact1Id,
          contact2Id: contact3Id,
          confidence: 0.7,
          source: "email_match",
          status: "rejected",
          createdAt: Date.now(),
        });
      });

      const result = await asUser.query(
        api.contacts.getPendingMergeSuggestions,
        {},
      );

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].status).toBe("pending");
    });

    it("respects limit parameter", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Create 5 merge suggestions
        for (let i = 0; i < 5; i++) {
          const contact1Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId),
          );
          const contact2Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId),
          );

          await ctx.db.insert("mergeSuggestions", {
            userId,
            contact1Id,
            contact2Id,
            confidence: 0.8,
            source: "email_match",
            status: "pending",
            createdAt: Date.now(),
          });
        }
      });

      const result = await asUser.query(
        api.contacts.getPendingMergeSuggestions,
        { limit: 2 },
      );

      expect(result.suggestions).toHaveLength(2);
    });
  });

  describe("getPendingMergeSuggestionCount query", () => {
    it("returns 0 for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const result = await t.query(
        api.contacts.getPendingMergeSuggestionCount,
        {},
      );

      expect(result).toBe(0);
    });

    it("returns count of pending suggestions", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 3; i++) {
          const contact1Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId),
          );
          const contact2Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId),
          );

          await ctx.db.insert("mergeSuggestions", {
            userId,
            contact1Id,
            contact2Id,
            confidence: 0.85,
            source: "phone_match",
            status: "pending",
            createdAt: Date.now(),
          });
        }
      });

      const result = await asUser.query(
        api.contacts.getPendingMergeSuggestionCount,
        {},
      );

      expect(result).toBe(3);
    });
  });

  describe("createMergeSuggestion mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        return { contact1Id, contact2Id };
      });

      await expect(
        t.mutation(api.contacts.createMergeSuggestion, {
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("creates merge suggestion", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John Doe",
          }),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "John D.",
          }),
        );
        return { contact1Id, contact2Id };
      });

      const result = await asUser.mutation(api.contacts.createMergeSuggestion, {
        contact1Id,
        contact2Id,
        confidence: 0.85,
        source: "email_match",
        reasoning: "Email addresses match",
      });

      expect(result.success).toBe(true);
      expect(result.suggestionId).toBeTruthy();

      // Verify suggestion was created
      const suggestion = await t.run(async (ctx) =>
        ctx.db.get(result.suggestionId!),
      );
      expect(suggestion?.confidence).toBe(0.85);
      expect(suggestion?.source).toBe("email_match");
      expect(suggestion?.reasoning).toBe("Email addresses match");
      expect(suggestion?.status).toBe("pending");
    });

    it("returns false when suggestion already exists", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        // Create existing suggestion
        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "phone_match",
          status: "pending",
          createdAt: Date.now(),
        });

        return { contact1Id, contact2Id };
      });

      const result = await asUser.mutation(api.contacts.createMergeSuggestion, {
        contact1Id,
        contact2Id,
        confidence: 0.85,
        source: "email_match",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Suggestion already exists");
    });

    it("returns false when reverse suggestion already exists", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        // Create existing suggestion in reverse order
        await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id: contact2Id, // reversed
          contact2Id: contact1Id, // reversed
          confidence: 0.9,
          source: "phone_match",
          status: "pending",
          createdAt: Date.now(),
        });

        return { contact1Id, contact2Id };
      });

      const result = await asUser.mutation(api.contacts.createMergeSuggestion, {
        contact1Id,
        contact2Id,
        confidence: 0.85,
        source: "email_match",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Suggestion already exists");
    });

    it("throws when contact1 not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeId, contact2Id } = await t.run(async (ctx) => {
        const fakeId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        await ctx.db.delete(fakeId);

        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        return { fakeId, contact2Id };
      });

      await expect(
        asUser.mutation(api.contacts.createMergeSuggestion, {
          contact1Id: fakeId,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
        }),
      ).rejects.toThrow("Contact 1 not found");
    });

    it("returns false when pair is marked keep-separate", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const [c1, c2] =
          contact1Id < contact2Id
            ? [contact1Id, contact2Id]
            : [contact2Id, contact1Id];
        await ctx.db.insert("contactExclusions", {
          userId,
          contact1Id: c1,
          contact2Id: c2,
          createdAt: Date.now(),
        });
        return { contact1Id, contact2Id };
      });

      const result = await asUser.mutation(api.contacts.createMergeSuggestion, {
        contact1Id,
        contact2Id,
        confidence: 0.9,
        source: "email_match",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Contacts are marked keep-separate");
    });
  });

  describe("rejectMerge mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const suggestionId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        return ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });
      });

      await expect(
        t.mutation(api.contacts.rejectMerge, { suggestionId }),
      ).rejects.toThrow("Unauthorized");
    });

    it("rejects merge suggestion", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const suggestionId = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        return ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });
      });

      const result = await asUser.mutation(api.contacts.rejectMerge, {
        suggestionId,
      });

      expect(result.success).toBe(true);

      const suggestion = await t.run(async (ctx) => ctx.db.get(suggestionId));
      expect(suggestion?.status).toBe("rejected");
      expect(suggestion?.resolvedAt).toBeTruthy();
    });

    it("throws when suggestion not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const fakeId = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const contact2Id = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );

        const id = await ctx.db.insert("mergeSuggestions", {
          userId,
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
          status: "pending",
          createdAt: Date.now(),
        });
        await ctx.db.delete(id);
        return id;
      });

      await expect(
        asUser.mutation(api.contacts.rejectMerge, { suggestionId: fakeId }),
      ).rejects.toThrow("Merge suggestion not found");
    });
  });

  describe("dismissContact mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const { actionId, contactId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "new_connection",
            contactId,
          }),
        );
        return { actionId, contactId };
      });

      await expect(
        t.mutation(api.contacts.dismissContact, { actionId, contactId }),
      ).rejects.toThrow("Unauthorized");
    });

    it("archives contact and marks action as discarded", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "new_connection",
            contactId,
            status: "pending",
          }),
        );
        return { actionId, contactId };
      });

      const result = await asUser.mutation(api.contacts.dismissContact, {
        actionId,
        contactId,
      });

      expect(result.success).toBe(true);

      // Verify contact is archived
      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.status).toBe("archived");
      expect(contact?.isDismissed).toBeUndefined();

      // Verify action is discarded
      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("discarded");
      expect(action?.discardedAt).toBeTruthy();

      // Verify pending count decremented
      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });

    it("throws when action not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeActionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const fakeActionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId),
        );
        await ctx.db.delete(fakeActionId);
        return { fakeActionId, contactId };
      });

      await expect(
        asUser.mutation(api.contacts.dismissContact, {
          actionId: fakeActionId,
          contactId,
        }),
      ).rejects.toThrow("Action not found");
    });

    it("throws when contact not found", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { actionId, fakeContactId } = await t.run(async (ctx) => {
        const fakeContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        await ctx.db.delete(fakeContactId);

        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId),
        );
        return { actionId, fakeContactId };
      });

      await expect(
        asUser.mutation(api.contacts.dismissContact, {
          actionId,
          contactId: fakeContactId,
        }),
      ).rejects.toThrow("Contact not found");
    });
  });

  describe("keepSeparate mutation", () => {
    it("throws when suggestion does not match selected contact pair", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id, mismatchSuggestionId } = await t.run(
        async (ctx) => {
          const contact1Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary" }),
          );
          const contact2Id = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary" }),
          );
          const otherContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Other" }),
          );

          const mismatchSuggestionId = await ctx.db.insert("mergeSuggestions", {
            userId,
            contact1Id,
            contact2Id: otherContactId,
            confidence: 0.72,
            source: "fuzzy_name_match",
            status: "pending",
            createdAt: Date.now(),
          });

          return { contact1Id, contact2Id, mismatchSuggestionId };
        },
      );

      await expect(
        asUser.mutation(api.contacts.keepSeparate, {
          contact1Id,
          contact2Id,
          suggestionId: mismatchSuggestionId,
        }),
      ).rejects.toThrow("Merge suggestion does not match selected contacts");
    });
  });

  describe("setContactStatus mutation", () => {
    it("discards pending actions where contact is either primary or secondary", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 2 });
      });

      const { primaryContactId, primaryActionId, secondaryActionId } =
        await t.run(async (ctx) => {
          const primaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary" }),
          );
          const secondaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary" }),
          );

          const primaryActionId = await ctx.db.insert(
            "actions",
            createTestActionData(userId, {
              type: "new_connection",
              contactId: primaryContactId,
              status: "pending",
            }),
          );

          const secondaryActionId = await ctx.db.insert("actions", {
            ...createTestActionData(userId, {
              type: "resolve_contact",
              contactId: secondaryContactId,
              status: "pending",
            }),
            secondaryContactId: primaryContactId,
          });

          return { primaryContactId, primaryActionId, secondaryActionId };
        });

      const result = await asUser.mutation(api.contacts.setContactStatus, {
        contactId: primaryContactId,
        status: "archived",
      });
      expect(result.success).toBe(true);

      const [primaryAction, secondaryAction, user] = await t.run(async (ctx) => {
        const primaryAction = await ctx.db.get(primaryActionId);
        const secondaryAction = await ctx.db.get(secondaryActionId);
        const user = await ctx.db.get(userId);
        return [primaryAction, secondaryAction, user];
      });

      expect(primaryAction?.status).toBe("discarded");
      expect(secondaryAction?.status).toBe("discarded");
      expect(user?.pendingActionCount).toBe(0);
    });
  });

  describe("unmergeContact mutation", () => {
    it("is idempotent for the same merge audit entry", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryContactId, secondaryContactId, secondaryHandleId } =
        await t.run(async (ctx) => {
          const primaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary Contact" }),
          );
          const secondaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary Contact" }),
          );
          const secondaryHandleId = await ctx.db.insert(
            "contactHandles",
            createTestContactHandleData(userId, secondaryContactId, {
              handle: "+15550001111",
            }),
          );
          const conversationId = await ctx.db.insert(
            "conversations",
            createTestConversationData(userId, {
              participantContactIds: [primaryContactId, secondaryContactId],
            }),
          );
          await ctx.db.insert("messages", {
            ...createTestMessageData(userId, conversationId, {
              senderContactId: secondaryContactId,
            }),
            senderHandleId: secondaryHandleId,
          });
          return { primaryContactId, secondaryContactId, secondaryHandleId };
        });

      const mergeResult = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId,
        secondaryContactId,
      });
      expect(mergeResult.success).toBe(true);

      const mergeAuditId = await t.run(async (ctx) => {
        const entries = await ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .collect();
        return entries[0]?._id;
      });
      expect(mergeAuditId).toBeTruthy();

      const unmergeableBefore = await asUser.query(api.contacts.getUnmergeableHistory, {
        contactId: primaryContactId,
      });
      expect(unmergeableBefore).toHaveLength(1);
      expect(unmergeableBefore[0]?._id).toEqual(mergeAuditId);

      const first = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(first.success).toBe(true);

      const second = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(second.success).toBe(true);
      expect(second.alreadyUnmerged).toBe(true);
      expect(second.restoredContactId).toEqual(first.restoredContactId);

      const restoredCount = await t.run(async (ctx) => {
        const contacts = await ctx.db
          .query("contacts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect();
        return contacts.filter((c) => c.displayName === "Secondary Contact")
          .length;
      });
      expect(restoredCount).toBe(1);

      const movedHandle = await t.run(async (ctx) => ctx.db.get(secondaryHandleId));
      expect(movedHandle?.contactId).toEqual(first.restoredContactId);

      const unmergeableAfter = await asUser.query(api.contacts.getUnmergeableHistory, {
        contactId: primaryContactId,
      });
      expect(unmergeableAfter).toHaveLength(0);

      const exclusion = await t.run(async (ctx) => {
        const [contact1Id, contact2Id] =
          primaryContactId < first.restoredContactId
            ? [primaryContactId, first.restoredContactId]
            : [first.restoredContactId, primaryContactId];
        return ctx.db
          .query("contactExclusions")
          .withIndex("by_pair", (q) =>
            q.eq("contact1Id", contact1Id).eq("contact2Id", contact2Id),
          )
          .first();
      });
      expect(exclusion).toBeTruthy();
    });

    it("removes primary from conversations where merge had injected it", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryContactId, secondaryContactId, conversationId } = await t.run(
        async (ctx) => {
          const primaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary Contact" }),
          );
          const secondaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary Contact" }),
          );
          const conversationId = await ctx.db.insert(
            "conversations",
            createTestConversationData(userId, {
              participantContactIds: [secondaryContactId],
            }),
          );
          return { primaryContactId, secondaryContactId, conversationId };
        },
      );

      const mergeResult = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId,
        secondaryContactId,
      });
      expect(mergeResult.success).toBe(true);

      const conversationAfterMerge = await t.run(async (ctx) =>
        ctx.db.get(conversationId),
      );
      expect(conversationAfterMerge?.participantContactIds).toEqual([
        primaryContactId,
      ]);

      const mergeAuditId = await t.run(async (ctx) => {
        const entry = await ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .first();
        return entry?._id;
      });
      expect(mergeAuditId).toBeTruthy();

      const unmergeResult = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(unmergeResult.success).toBe(true);

      const conversationAfterUnmerge = await t.run(async (ctx) =>
        ctx.db.get(conversationId),
      );
      expect(conversationAfterUnmerge?.participantContactIds).toEqual([
        unmergeResult.restoredContactId,
      ]);
    });

    it("keeps primary in conversations where it existed before merge", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryContactId, secondaryContactId, conversationId } = await t.run(
        async (ctx) => {
          const primaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Primary Contact" }),
          );
          const secondaryContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, { displayName: "Secondary Contact" }),
          );
          const conversationId = await ctx.db.insert(
            "conversations",
            createTestConversationData(userId, {
              participantContactIds: [primaryContactId, secondaryContactId],
            }),
          );
          return { primaryContactId, secondaryContactId, conversationId };
        },
      );

      const mergeResult = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId,
        secondaryContactId,
      });
      expect(mergeResult.success).toBe(true);

      const mergeAuditId = await t.run(async (ctx) => {
        const entry = await ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .first();
        return entry?._id;
      });
      expect(mergeAuditId).toBeTruthy();

      const unmergeResult = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(unmergeResult.success).toBe(true);

      const conversationAfterUnmerge = await t.run(async (ctx) =>
        ctx.db.get(conversationId),
      );
      expect(conversationAfterUnmerge).not.toBeNull();
      expect(conversationAfterUnmerge?.participantContactIds).toContain(
        primaryContactId,
      );
      expect(conversationAfterUnmerge?.participantContactIds).toContain(
        unmergeResult.restoredContactId,
      );
      expect(conversationAfterUnmerge?.participantContactIds).toHaveLength(2);
    });

    it("recreates deduped handles and restores senderHandleId", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const {
        primaryContactId,
        secondaryContactId,
        primaryHandleId,
        secondaryHandleId,
        messageId,
      } = await t.run(async (ctx) => {
        const primaryContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Primary" }),
        );
        const secondaryContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Secondary" }),
        );

        const primaryHandleId = await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, primaryContactId, {
            handleType: "email",
            handle: "shared@example.com",
          }),
        );
        const secondaryHandleId = await ctx.db.insert(
          "contactHandles",
          createTestContactHandleData(userId, secondaryContactId, {
            handleType: "email",
            handle: "shared@example.com",
          }),
        );

        const conversationId = await ctx.db.insert(
          "conversations",
          createTestConversationData(userId, {
            participantContactIds: [primaryContactId, secondaryContactId],
          }),
        );
        const messageId = await ctx.db.insert("messages", {
          ...createTestMessageData(userId, conversationId, {
            senderContactId: secondaryContactId,
          }),
          senderHandleId: secondaryHandleId,
        });

        return {
          primaryContactId,
          secondaryContactId,
          primaryHandleId,
          secondaryHandleId,
          messageId,
        };
      });

      const mergeResult = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId,
        secondaryContactId,
      });
      expect(mergeResult.success).toBe(true);

      const { mergeAuditId, deletedSecondaryHandle } = await t.run(async (ctx) => {
        const mergeAudit = await ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .first();
        const deletedSecondaryHandle = await ctx.db.get(secondaryHandleId);
        return {
          mergeAuditId: mergeAudit?._id,
          deletedSecondaryHandle,
        };
      });

      expect(mergeAuditId).toBeTruthy();
      expect(deletedSecondaryHandle).toBeNull();

      await t.run(async (ctx) => {
        const mergeAudit = await ctx.db.get(mergeAuditId!);
        const details =
          ((mergeAudit?.details ?? {}) as { messageIds?: unknown } & Record<string, unknown>);
        const { messageIds: _ignored, ...detailsWithoutMessageIds } = details;

        await ctx.db.patch(mergeAuditId!, {
          details: detailsWithoutMessageIds as any,
        });
        await ctx.db.insert("contactMergeMessageRefs", {
          userId,
          mergeAuditId: mergeAuditId!,
          messageId,
        });
      });

      const unmergeResult = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(unmergeResult.success).toBe(true);

      const { restoredHandles, primaryHandle, restoredMessage } = await t.run(async (ctx) => {
        const restoredHandles = await ctx.db
          .query("contactHandles")
          .withIndex("by_contact", (q) =>
            q.eq("contactId", unmergeResult.restoredContactId),
          )
          .collect();
        const primaryHandle = await ctx.db.get(primaryHandleId);
        const restoredMessage = await ctx.db.get(messageId);
        return {
          restoredHandles,
          primaryHandle,
          restoredMessage,
        };
      });

      expect(restoredHandles).toHaveLength(1);
      expect(restoredHandles[0]?.handleType).toBe("email");
      expect(restoredHandles[0]?.handle).toBe("shared@example.com");
      expect(primaryHandle?.contactId).toEqual(primaryContactId);
      expect(restoredMessage?.senderContactId).toEqual(unmergeResult.restoredContactId);
      expect(restoredMessage?.senderHandleId).toEqual(restoredHandles[0]?._id);
    });

    it("restores primary fields changed by merge", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryContactId, secondaryContactId } = await t.run(async (ctx) => {
        const primaryContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Original Primary",
            company: "Original Co",
            notes: "Original notes",
            importance: 3,
            tags: ["vip"],
          }),
        );
        const secondaryContactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Secondary Winner",
            company: "Secondary Co",
            notes: "Secondary notes",
            tags: ["friend"],
          }),
        );
        return { primaryContactId, secondaryContactId };
      });

      const mergeResult = await asUser.mutation(api.contacts.manualMerge, {
        primaryContactId,
        secondaryContactId,
        fieldResolutions: {
          displayName: "secondary",
          company: "secondary",
          notes: "secondary",
        },
      });
      expect(mergeResult.success).toBe(true);

      const mergeAuditId = await t.run(async (ctx) => {
        const entry = await ctx.db
          .query("contactAuditLog")
          .withIndex("by_contact", (q) => q.eq("contactId", primaryContactId))
          .filter((q) => q.eq(q.field("action"), "merge"))
          .first();
        return entry?._id;
      });
      expect(mergeAuditId).toBeTruthy();

      const mergedPrimary = await t.run(async (ctx) => ctx.db.get(primaryContactId));
      expect(mergedPrimary?.displayName).toBe("Secondary Winner");
      expect(mergedPrimary?.company).toBe("Secondary Co");
      expect(mergedPrimary?.notes).toBe("Secondary notes");
      expect(mergedPrimary?.tags).toEqual(["vip", "friend"]);

      const unmergeResult = await asUser.mutation(api.contacts.unmergeContact, {
        auditLogId: mergeAuditId!,
      });
      expect(unmergeResult.success).toBe(true);

      const restoredPrimary = await t.run(async (ctx) => ctx.db.get(primaryContactId));
      expect(restoredPrimary?.displayName).toBe("Original Primary");
      expect(restoredPrimary?.company).toBe("Original Co");
      expect(restoredPrimary?.notes).toBe("Original notes");
      expect(restoredPrimary?.importance).toBe(3);
      expect(restoredPrimary?.tags).toEqual(["vip"]);
    });
  });

  describe("saveContactFromCard mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = trackTest(convexTest(schema, modules));

      const { actionId, contactId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId),
        );
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "new_connection",
            contactId,
          }),
        );
        return { actionId, contactId };
      });

      await expect(
        t.mutation(api.contacts.saveContactFromCard, {
          actionId,
          contactId,
          displayName: "John Doe",
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("updates contact and completes action", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, {
            displayName: "Unknown",
          }),
        );
        const actionId = await ctx.db.insert(
          "actions",
          createTestActionData(userId, {
            type: "new_connection",
            contactId,
            status: "pending",
          }),
        );
        return { actionId, contactId };
      });

      const result = await asUser.mutation(api.contacts.saveContactFromCard, {
        actionId,
        contactId,
        displayName: "John Doe",
        company: "Acme Corp",
        notes: "Met at conference",
        tags: ["friend", "networking"],
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(false);
      expect(result.contactId).toEqual(contactId);

      // Verify contact updated
      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.displayName).toBe("John Doe");
      expect(contact?.company).toBe("Acme Corp");
      expect(contact?.notes).toBe("Met at conference");
      expect(contact?.tags).toEqual(["friend", "networking"]);

      // Verify action completed
      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("completed");
      expect(action?.completedAt).toBeTruthy();

      // Verify pending count decremented
      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });

    it("links to existing contact and merges handles", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, newContactId, existingContactId, newHandleId } =
        await t.run(async (ctx) => {
          // Existing contact
          const existingContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "John Doe",
              company: "Acme Corp",
            }),
          );

          // New contact (from unknown sender)
          const newContactId = await ctx.db.insert(
            "contacts",
            createTestContactData(userId, {
              displayName: "Unknown",
            }),
          );

          // Handle on new contact
          const newHandleId = await ctx.db.insert(
            "contactHandles",
            createTestContactHandleData(userId, newContactId, {
              handle: "+15559999999",
            }),
          );

          const actionId = await ctx.db.insert(
            "actions",
            createTestActionData(userId, {
              type: "eod_contact",
              contactId: newContactId,
              status: "pending",
            }),
          );

          return { actionId, newContactId, existingContactId, newHandleId };
        });

      const result = await asUser.mutation(api.contacts.saveContactFromCard, {
        actionId,
        contactId: newContactId,
        displayName: "John Doe",
        notes: "Also known from phone",
        linkToContactId: existingContactId,
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.contactId).toEqual(existingContactId);

      // Verify handle moved to existing contact
      const handle = await t.run(async (ctx) => ctx.db.get(newHandleId));
      expect(handle?.contactId).toEqual(existingContactId);

      // Verify new contact deleted
      const newContact = await t.run(async (ctx) => ctx.db.get(newContactId));
      expect(newContact).toBeNull();

      // Verify notes appended to existing contact
      const existingContact = await t.run(async (ctx) =>
        ctx.db.get(existingContactId),
      );
      expect(existingContact?.notes).toBe("Also known from phone");
    });
  });

  describe("merge check coalescing via _scheduled_functions", () => {
    it("coalesces multiple merge checks for the same user into one pending scan", async () => {
      const t = trackTest(convexTest(schema, modules));
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create two contacts with handles
      const { contactA, contactB } = await t.run(async (ctx) => {
        const contactA = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Contact A" }),
        );
        const contactB = await ctx.db.insert(
          "contacts",
          createTestContactData(userId, { displayName: "Contact B" }),
        );
        return { contactA, contactB };
      });

      // Add a handle to contact A — triggers scheduleContactMergeCheck
      await asUser.mutation(api.contacts.addContactHandle, {
        contactId: contactA,
        handleType: "email",
        handle: "a@example.com",
        platform: "imessage",
      });

      // Check: exactly one pending scanAllContactsForMerges
      const pendingAfterFirst = await t.run(async (ctx) => {
        const all = await ctx.db.system
          .query("_scheduled_functions")
          .collect();
        return all.filter(
          (fn) =>
            fn.name.includes("scanAllContactsForMerges") &&
            fn.state.kind === "pending",
        );
      });
      expect(pendingAfterFirst).toHaveLength(1);

      // Add a handle to contact B — should be coalesced (not create a second scan)
      await asUser.mutation(api.contacts.addContactHandle, {
        contactId: contactB,
        handleType: "email",
        handle: "b@example.com",
        platform: "imessage",
      });

      // Check: still exactly one pending scan
      const pendingAfterSecond = await t.run(async (ctx) => {
        const all = await ctx.db.system
          .query("_scheduled_functions")
          .collect();
        return all.filter(
          (fn) =>
            fn.name.includes("scanAllContactsForMerges") &&
            fn.state.kind === "pending",
        );
      });
      expect(pendingAfterSecond).toHaveLength(1);
    });
  });
});

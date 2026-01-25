/**
 * Tests for Convex contacts functions.
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
  createTestContactHandleData,
  createTestConversationData,
  createTestMessageData,
  createTestActionData,
  createTestIdentity,
} from "./helpers";
import { api } from "../_generated/api";

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

describe("contacts", () => {
  describe("getContacts query", () => {
    it("returns empty array for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.contacts.getContacts, {});

      expect(result).toEqual({ contacts: [], nextCursor: null });
    });

    it("returns contacts for authenticated user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create contacts
      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Smith",
        }));
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Bob Jones",
        }));
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(2);
    });

    it("returns contacts sorted alphabetically by displayName", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Zara",
        }));
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice",
        }));
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Mike",
        }));
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(3);
      expect(result.contacts[0].displayName).toBe("Alice");
      expect(result.contacts[1].displayName).toBe("Mike");
      expect(result.contacts[2].displayName).toBe("Zara");
    });

    it("includes handles for each contact", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Smith",
        }));

        // Add multiple handles
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, contactId, {
          handleType: "phone",
          handle: "+15551234567",
          platform: "imessage",
        }));
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, contactId, {
          handleType: "email",
          handle: "alice@example.com",
          platform: "gmail",
        }));
      });

      const result = await asUser.query(api.contacts.getContacts, {});

      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].handles).toHaveLength(2);
      expect(result.contacts[0].handles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "phone", value: "+15551234567" }),
          expect.objectContaining({ type: "email", value: "alice@example.com" }),
        ])
      );
    });

    it("excludes dismissed contacts", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Active Contact",
        }));
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

    it("supports cursor-based pagination", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Create 5 contacts
        for (const name of ["Alice", "Bob", "Carol", "David", "Eve"]) {
          await ctx.db.insert("contacts", createTestContactData(userId, {
            displayName: name,
          }));
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Smith",
        }));
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Bob Johnson",
        }));
        await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Alice Cooper",
        }));
      });

      const result = await asUser.query(api.contacts.getContacts, {
        searchQuery: "Alice",
      });

      expect(result.contacts).toHaveLength(2);
      expect(result.contacts.every((c) => c.displayName.includes("Alice"))).toBe(true);
    });

    it("respects limit parameter", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert("contacts", createTestContactData(userId, {
            displayName: `Contact ${i}`,
          }));
        }
      });

      const result = await asUser.query(api.contacts.getContacts, { limit: 3 });

      expect(result.contacts).toHaveLength(3);
      expect(result.nextCursor).toBeTruthy();
    });
  });

  describe("getContact query", () => {
    it("returns null for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      // Create a contact
      const contactId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("contacts", createTestContactData(userId));
      });

      const result = await t.query(api.contacts.getContact, { contactId });

      expect(result).toBeNull();
    });

    it("returns contact with handles for authenticated user", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John Doe",
          company: "Acme Corp",
          notes: "Met at conference",
        }));

        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, contactId, {
          handleType: "phone",
          handle: "+15551234567",
        }));

        return contactId;
      });

      const result = await asUser.query(api.contacts.getContact, { contactId });

      expect(result).toBeTruthy();
      expect(result?.displayName).toBe("John Doe");
      expect(result?.company).toBe("Acme Corp");
      expect(result?.notes).toBe("Met at conference");
      expect(result?.handles).toHaveLength(1);
      expect(result?.handles[0]).toEqual(
        expect.objectContaining({ type: "phone", value: "+15551234567" })
      );
    });

    it("returns null for contact belonging to different user", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      // Create contact for a different user
      const contactId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert("users", createTestUserData({
          workosUserId: "other_user_id",
        }));
        return ctx.db.insert("contacts", createTestContactData(otherUserId));
      });

      const result = await asUser.query(api.contacts.getContact, { contactId });

      expect(result).toBeNull();
    });
  });

  describe("updateContact mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const contactId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        return ctx.db.insert("contacts", createTestContactData(userId));
      });

      await expect(
        t.mutation(api.contacts.updateContact, {
          contactId,
          displayName: "Updated Name",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("updates contact displayName", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Original Name",
        }));
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John Doe",
        }));
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
      const t = convexTest(schema, modules);
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", createTestContactData(userId, {
          importance: 0,
        }));
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const contactId = await t.run(async (ctx) => {
        return ctx.db.insert("contacts", createTestContactData(userId, {
          tags: ["old-tag"],
        }));
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      // Create and delete a contact to get an invalid ID
      const fakeContactId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("contacts", createTestContactData(userId));
        await ctx.db.delete(id);
        return id;
      });

      await expect(
        asUser.mutation(api.contacts.updateContact, {
          contactId: fakeContactId,
          displayName: "Test",
        })
      ).rejects.toThrow("Contact not found");
    });

    it("throws when contact belongs to different user", async () => {
      const t = convexTest(schema, modules);
      const { asUser } = await setupAuthenticatedUser(t);

      // Create contact for a different user
      const contactId = await t.run(async (ctx) => {
        const otherUserId = await ctx.db.insert("users", createTestUserData({
          workosUserId: "other_user_id",
        }));
        return ctx.db.insert("contacts", createTestContactData(otherUserId));
      });

      await expect(
        asUser.mutation(api.contacts.updateContact, {
          contactId,
          displayName: "Hacked",
        })
      ).rejects.toThrow("Contact not found");
    });
  });

  describe("mergeContacts mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Primary",
        }));
        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Secondary",
        }));
        return { primaryId, secondaryId };
      });

      await expect(
        t.mutation(api.contacts.mergeContacts, {
          primaryContactId: primaryId,
          secondaryContactId: secondaryId,
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("moves handles from secondary to primary contact", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Primary Contact",
        }));
        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Secondary Contact",
        }));

        // Add handles to both
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, primaryId, {
          handle: "+15551111111",
        }));
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, secondaryId, {
          handle: "+15552222222",
        }));
        await ctx.db.insert("contactHandles", createTestContactHandleData(userId, secondaryId, {
          handleType: "email",
          handle: "secondary@example.com",
          platform: "gmail",
        }));

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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, conversationId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Primary",
        }));
        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Secondary",
        }));

        // Create conversation with secondary contact
        const conversationId = await ctx.db.insert("conversations", createTestConversationData(userId, {
          participantContactIds: [secondaryId],
        }));

        return { primaryId, secondaryId, conversationId };
      });

      const result = await asUser.mutation(api.contacts.mergeContacts, {
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
      });

      expect(result.success).toBe(true);
      expect(result.conversationsUpdatedCount).toBe(1);

      // Verify conversation now references primary
      const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
      expect(conversation?.participantContactIds).toContain(primaryId);
      expect(conversation?.participantContactIds).not.toContain(secondaryId);
    });

    it("updates messages referencing secondary contact", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId, messageId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Primary",
        }));
        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Secondary",
        }));

        const conversationId = await ctx.db.insert("conversations", createTestConversationData(userId));

        // Create message from secondary contact
        const messageId = await ctx.db.insert("messages", createTestMessageData(userId, conversationId, {
          senderContactId: secondaryId,
          content: "Hello from secondary",
        }));

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

    it("merges metadata - fills gaps from secondary", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, secondaryId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Primary",
          company: undefined, // No company
          notes: "Primary notes",
        }));
        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Secondary",
          company: "Secondary Co",
          notes: "Secondary notes",
        }));

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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeId, secondaryId } = await t.run(async (ctx) => {
        const fakeId = await ctx.db.insert("contacts", createTestContactData(userId));
        await ctx.db.delete(fakeId);

        const secondaryId = await ctx.db.insert("contacts", createTestContactData(userId));
        return { fakeId, secondaryId };
      });

      await expect(
        asUser.mutation(api.contacts.mergeContacts, {
          primaryContactId: fakeId,
          secondaryContactId: secondaryId,
        })
      ).rejects.toThrow("Primary contact not found");
    });

    it("throws when secondary contact not found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { primaryId, fakeId } = await t.run(async (ctx) => {
        const primaryId = await ctx.db.insert("contacts", createTestContactData(userId));

        const fakeId = await ctx.db.insert("contacts", createTestContactData(userId));
        await ctx.db.delete(fakeId);

        return { primaryId, fakeId };
      });

      await expect(
        asUser.mutation(api.contacts.mergeContacts, {
          primaryContactId: primaryId,
          secondaryContactId: fakeId,
        })
      ).rejects.toThrow("Secondary contact not found");
    });
  });

  describe("getPendingMergeSuggestions query", () => {
    it("returns empty for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.contacts.getPendingMergeSuggestions, {});

      expect(result).toEqual({ suggestions: [] });
    });

    it("returns pending merge suggestions with contact details", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John Doe",
        }));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John D",
        }));

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

      const result = await asUser.query(api.contacts.getPendingMergeSuggestions, {});

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].confidence).toBe(0.85);
      expect(result.suggestions[0].contact1?.displayName).toBe("John Doe");
      expect(result.suggestions[0].contact2?.displayName).toBe("John D");
    });

    it("excludes approved and rejected suggestions", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact3Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact4Id = await ctx.db.insert("contacts", createTestContactData(userId));

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

      const result = await asUser.query(api.contacts.getPendingMergeSuggestions, {});

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].status).toBe("pending");
    });

    it("respects limit parameter", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        // Create 5 merge suggestions
        for (let i = 0; i < 5; i++) {
          const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
          const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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

      const result = await asUser.query(api.contacts.getPendingMergeSuggestions, { limit: 2 });

      expect(result.suggestions).toHaveLength(2);
    });
  });

  describe("getPendingMergeSuggestionCount query", () => {
    it("returns 0 for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const result = await t.query(api.contacts.getPendingMergeSuggestionCount, {});

      expect(result).toBe(0);
    });

    it("returns count of pending suggestions", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 3; i++) {
          const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
          const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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

      const result = await asUser.query(api.contacts.getPendingMergeSuggestionCount, {});

      expect(result).toBe(3);
    });
  });

  describe("createMergeSuggestion mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));
        return { contact1Id, contact2Id };
      });

      await expect(
        t.mutation(api.contacts.createMergeSuggestion, {
          contact1Id,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("creates merge suggestion", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John Doe",
        }));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John D.",
        }));
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
      const suggestion = await t.run(async (ctx) => ctx.db.get(result.suggestionId!));
      expect(suggestion?.confidence).toBe(0.85);
      expect(suggestion?.source).toBe("email_match");
      expect(suggestion?.reasoning).toBe("Email addresses match");
      expect(suggestion?.status).toBe("pending");
    });

    it("returns false when suggestion already exists", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { contact1Id, contact2Id } = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeId, contact2Id } = await t.run(async (ctx) => {
        const fakeId = await ctx.db.insert("contacts", createTestContactData(userId));
        await ctx.db.delete(fakeId);

        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));
        return { fakeId, contact2Id };
      });

      await expect(
        asUser.mutation(api.contacts.createMergeSuggestion, {
          contact1Id: fakeId,
          contact2Id,
          confidence: 0.9,
          source: "email_match",
        })
      ).rejects.toThrow("Contact 1 not found");
    });
  });

  describe("rejectMerge mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const suggestionId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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
        t.mutation(api.contacts.rejectMerge, { suggestionId })
      ).rejects.toThrow("Unauthorized");
    });

    it("rejects merge suggestion", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const suggestionId = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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

      const result = await asUser.mutation(api.contacts.rejectMerge, { suggestionId });

      expect(result.success).toBe(true);

      const suggestion = await t.run(async (ctx) => ctx.db.get(suggestionId));
      expect(suggestion?.status).toBe("rejected");
      expect(suggestion?.resolvedAt).toBeTruthy();
    });

    it("throws when suggestion not found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const fakeId = await t.run(async (ctx) => {
        const contact1Id = await ctx.db.insert("contacts", createTestContactData(userId));
        const contact2Id = await ctx.db.insert("contacts", createTestContactData(userId));

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
        asUser.mutation(api.contacts.rejectMerge, { suggestionId: fakeId })
      ).rejects.toThrow("Merge suggestion not found");
    });
  });

  describe("dismissContact mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const { actionId, contactId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          type: "new_connection",
          contactId,
        }));
        return { actionId, contactId };
      });

      await expect(
        t.mutation(api.contacts.dismissContact, { actionId, contactId })
      ).rejects.toThrow("Unauthorized");
    });

    it("marks contact as dismissed and action as discarded", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          type: "new_connection",
          contactId,
          status: "pending",
        }));
        return { actionId, contactId };
      });

      const result = await asUser.mutation(api.contacts.dismissContact, {
        actionId,
        contactId,
      });

      expect(result.success).toBe(true);

      // Verify contact is dismissed
      const contact = await t.run(async (ctx) => ctx.db.get(contactId));
      expect(contact?.isDismissed).toBe(true);

      // Verify action is discarded
      const action = await t.run(async (ctx) => ctx.db.get(actionId));
      expect(action?.status).toBe("discarded");
      expect(action?.discardedAt).toBeTruthy();

      // Verify pending count decremented
      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user?.pendingActionCount).toBe(0);
    });

    it("throws when action not found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { fakeActionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const fakeActionId = await ctx.db.insert("actions", createTestActionData(userId));
        await ctx.db.delete(fakeActionId);
        return { fakeActionId, contactId };
      });

      await expect(
        asUser.mutation(api.contacts.dismissContact, {
          actionId: fakeActionId,
          contactId,
        })
      ).rejects.toThrow("Action not found");
    });

    it("throws when contact not found", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      const { actionId, fakeContactId } = await t.run(async (ctx) => {
        const fakeContactId = await ctx.db.insert("contacts", createTestContactData(userId));
        await ctx.db.delete(fakeContactId);

        const actionId = await ctx.db.insert("actions", createTestActionData(userId));
        return { actionId, fakeContactId };
      });

      await expect(
        asUser.mutation(api.contacts.dismissContact, {
          actionId,
          contactId: fakeContactId,
        })
      ).rejects.toThrow("Contact not found");
    });
  });

  describe("saveContactFromCard mutation", () => {
    it("throws for unauthenticated user", async () => {
      const t = convexTest(schema, modules);

      const { actionId, contactId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", createTestUserData());
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          type: "new_connection",
          contactId,
        }));
        return { actionId, contactId };
      });

      await expect(
        t.mutation(api.contacts.saveContactFromCard, {
          actionId,
          contactId,
          displayName: "John Doe",
        })
      ).rejects.toThrow("Unauthorized");
    });

    it("updates contact and completes action", async () => {
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, contactId } = await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Unknown",
        }));
        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          type: "new_connection",
          contactId,
          status: "pending",
        }));
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
      const t = convexTest(schema, modules);
      const { asUser, userId } = await setupAuthenticatedUser(t);

      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { pendingActionCount: 1 });
      });

      const { actionId, newContactId, existingContactId, newHandleId } = await t.run(async (ctx) => {
        // Existing contact
        const existingContactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "John Doe",
          company: "Acme Corp",
        }));

        // New contact (from unknown sender)
        const newContactId = await ctx.db.insert("contacts", createTestContactData(userId, {
          displayName: "Unknown",
        }));

        // Handle on new contact
        const newHandleId = await ctx.db.insert("contactHandles", createTestContactHandleData(userId, newContactId, {
          handle: "+15559999999",
        }));

        const actionId = await ctx.db.insert("actions", createTestActionData(userId, {
          type: "eod_contact",
          contactId: newContactId,
          status: "pending",
        }));

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
      const existingContact = await t.run(async (ctx) => ctx.db.get(existingContactId));
      expect(existingContact?.notes).toBe("Also known from phone");
    });
  });
});

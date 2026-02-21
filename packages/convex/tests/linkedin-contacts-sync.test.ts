import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { modules } from "./test.setup";
import { createTestIdentity, createTestUserData } from "./helpers.util";
import { api } from "../convex/_generated/api";
import { useSchedulerCleanup } from "./schedulerCleanup.util";

const { trackTest } = useSchedulerCleanup();

async function setupAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const identity = createTestIdentity();
  const asUser = t.withIdentity(identity);

  const userId = await t.run(async (ctx) => {
    return ctx.db.insert(
      "users",
      createTestUserData({
        workosUserId: identity.subject,
      }),
    );
  });

  return { asUser, userId };
}

describe("LinkedIn contacts sync", () => {
  it("stores avatar fields when creating a new contact", async () => {
    const t = trackTest(convexTest(schema, modules));
    const { asUser, userId } = await setupAuthenticatedUser(t);

    const result = await asUser.mutation(api.sync.syncLinkedInContacts, {
      contacts: [
        {
          name: "Alice Smith",
          profileUrl: "https://www.linkedin.com/in/alice-smith",
          headline: "Engineer at Example",
          profileId: "12345",
          avatarUrl: "https://cdn.example.com/alice.png",
        },
      ],
    });

    expect(result.newContacts).toBe(1);

    const contacts = await t.run(async (ctx) => {
      return ctx.db
        .query("contacts")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].avatarUrl).toBe("https://cdn.example.com/alice.png");
    expect(contacts[0].avatarSourcePlatform).toBe("linkedin");
    expect(typeof contacts[0].avatarUpdatedAt).toBe("number");
    expect(contacts[0].avatarOptions).toEqual([
      {
        url: "https://cdn.example.com/alice.png",
        sourcePlatform: "linkedin",
        updatedAt: expect.any(Number),
      },
    ]);
  });
});

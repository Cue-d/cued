/**
 * Tests for shared sync utilities.
 */

import { describe, expect, it } from "vitest";
import { buildContactAvatarPatch, shouldUpdateDisplayName } from "../convex/sync/shared";

describe("shouldUpdateDisplayName", () => {
  describe("basic cases", () => {
    it("returns false when newName is empty", () => {
      expect(shouldUpdateDisplayName("Alice", "", "+1555")).toBe(false);
    });

    it("returns false when names are identical", () => {
      expect(shouldUpdateDisplayName("Alice", "Alice", "+1555")).toBe(false);
    });
  });

  describe("placeholder detection - should update FROM placeholders", () => {
    it("updates from Slack user ID to real name", () => {
      expect(shouldUpdateDisplayName("U12345678", "Alice Smith", "U12345678")).toBe(true);
    });

    it("updates from LinkedIn URN to real name", () => {
      expect(shouldUpdateDisplayName("urn:li:member:123", "John Doe", "urn:li:member:123")).toBe(true);
    });

    it("updates from phone number to real name", () => {
      expect(shouldUpdateDisplayName("+15551234567", "Alice Smith", "+15551234567")).toBe(true);
    });

    it("updates from email to real name", () => {
      expect(shouldUpdateDisplayName("alice@example.com", "Alice Smith", "alice@example.com")).toBe(true);
    });

    it("updates when current name matches handle exactly", () => {
      expect(shouldUpdateDisplayName("alice", "Alice Smith", "alice")).toBe(true);
    });

    it("updates when current name matches handle case-insensitively", () => {
      expect(shouldUpdateDisplayName("ALICE", "Alice Smith", "alice")).toBe(true);
    });
  });

  describe("placeholder detection - should NOT update TO placeholders", () => {
    it("does not update to Slack user ID", () => {
      expect(shouldUpdateDisplayName("Alice", "U12345678", "alice")).toBe(false);
    });

    it("does not update to LinkedIn URN", () => {
      expect(shouldUpdateDisplayName("Alice", "urn:li:member:123", "alice")).toBe(false);
    });

    it("does not update to phone number", () => {
      expect(shouldUpdateDisplayName("Alice", "+15551234567", "alice")).toBe(false);
    });

    it("does not update to email", () => {
      expect(shouldUpdateDisplayName("Alice", "bob@example.com", "alice")).toBe(false);
    });

    it("does not update to a name that matches the handle", () => {
      expect(shouldUpdateDisplayName("Alice Smith", "alice", "alice")).toBe(false);
    });
  });

  describe("word count heuristic - prefer first+last names", () => {
    it("updates from single word to two words", () => {
      expect(shouldUpdateDisplayName("Alice", "Alice Smith", "alice@example.com")).toBe(true);
    });

    it("updates from single word to three words", () => {
      expect(shouldUpdateDisplayName("Alice", "Alice M. Smith", "alice@example.com")).toBe(true);
    });

    it("does not update from two words to single word", () => {
      expect(shouldUpdateDisplayName("Alice Smith", "Alice", "alice@example.com")).toBe(false);
    });

    it("does not update from two words to two words (no improvement)", () => {
      expect(shouldUpdateDisplayName("Alice Smith", "Bob Jones", "alice@example.com")).toBe(false);
    });

    it("does not update single word to single word", () => {
      expect(shouldUpdateDisplayName("Alice", "Bob", "alice@example.com")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles phone numbers with formatting", () => {
      // Current name is formatted phone - should update to real name
      expect(shouldUpdateDisplayName("(555) 123-4567", "Alice Smith", "+15551234567")).toBe(true);
    });

    it("handles lowercase Slack IDs", () => {
      expect(shouldUpdateDisplayName("u12345678", "Alice Smith", "u12345678")).toBe(true);
    });

    it("handles mixed case handles", () => {
      expect(shouldUpdateDisplayName("JohnDoe", "John Doe", "johndoe")).toBe(true);
    });

    it("preserves good names against handle-like updates", () => {
      // Current name is good, newName is just the handle - don't update
      expect(shouldUpdateDisplayName("John Smith", "johnsmith", "johnsmith")).toBe(false);
    });
  });
});

describe("buildContactAvatarPatch", () => {
  function makeContact(overrides?: {
    avatarUrl?: string;
    avatarSourcePlatform?: "linkedin" | "twitter" | "slack" | "imessage" | "signal";
    avatarUpdatedAt?: number;
    avatarOptions?: Array<{
      url: string;
      sourcePlatform: "linkedin" | "twitter" | "slack" | "imessage" | "signal";
      updatedAt: number;
    }>;
  }) {
    return {
      _id: "contact_1",
      _creationTime: Date.now(),
      userId: "user_1",
      displayName: "Alice",
      ...overrides,
    } as never;
  }

  it("adds avatar when contact has none", () => {
    const patch = buildContactAvatarPatch(
      makeContact(),
      {
        url: "https://cdn.example.com/avatar-a.png",
        sourcePlatform: "twitter",
        updatedAt: 1234,
      },
    );

    expect(patch).toEqual({
      avatarUrl: "https://cdn.example.com/avatar-a.png",
      avatarSourcePlatform: "twitter",
      avatarUpdatedAt: 1234,
      avatarOptions: [
        {
          url: "https://cdn.example.com/avatar-a.png",
          sourcePlatform: "twitter",
          updatedAt: 1234,
        },
      ],
    });
  });

  it("keeps primary avatar when lower-priority source arrives, but stores it as an option", () => {
    const patch = buildContactAvatarPatch(
      makeContact({
        avatarUrl: "https://cdn.example.com/old.png",
        avatarSourcePlatform: "linkedin",
        avatarUpdatedAt: 1000,
      }),
      {
        url: "https://cdn.example.com/new.png",
        sourcePlatform: "imessage",
        updatedAt: 5678,
      },
    );

    expect(patch).toEqual({
      avatarUrl: "https://cdn.example.com/old.png",
      avatarSourcePlatform: "linkedin",
      avatarUpdatedAt: 1000,
      avatarOptions: [
        {
          url: "https://cdn.example.com/old.png",
          sourcePlatform: "linkedin",
          updatedAt: 1000,
        },
        {
          url: "https://cdn.example.com/new.png",
          sourcePlatform: "imessage",
          updatedAt: 5678,
        },
      ],
    });
  });

  it("updates avatar when URL changes from same source", () => {
    const patch = buildContactAvatarPatch(
      makeContact({
        avatarUrl: "https://cdn.example.com/old.png",
        avatarSourcePlatform: "twitter",
      }),
      {
        url: "https://cdn.example.com/new.png",
        sourcePlatform: "twitter",
        updatedAt: 5678,
      },
    );

    expect(patch).toEqual({
      avatarUrl: "https://cdn.example.com/new.png",
      avatarSourcePlatform: "twitter",
      avatarUpdatedAt: 5678,
      avatarOptions: [
        {
          url: "https://cdn.example.com/new.png",
          sourcePlatform: "twitter",
          updatedAt: 5678,
        },
      ],
    });
  });

  it("updates source when a higher-priority source arrives with same URL", () => {
    const patch = buildContactAvatarPatch(
      makeContact({
        avatarUrl: "https://cdn.example.com/avatar.png",
        avatarSourcePlatform: "slack",
      }),
      {
        url: "https://cdn.example.com/avatar.png",
        sourcePlatform: "linkedin",
      },
    );

    expect(patch?.avatarSourcePlatform).toBe("linkedin");
    expect(patch?.avatarUrl).toBe("https://cdn.example.com/avatar.png");
    expect(patch?.avatarUpdatedAt).toBeGreaterThan(0);
    expect(patch?.avatarOptions).toEqual([
      {
        url: "https://cdn.example.com/avatar.png",
        sourcePlatform: "linkedin",
        updatedAt: expect.any(Number),
      },
      {
        url: "https://cdn.example.com/avatar.png",
        sourcePlatform: "slack",
        updatedAt: 0,
      },
    ]);
  });

  it("backfills avatarOptions when incoming URL and source are unchanged", () => {
    const patch = buildContactAvatarPatch(
      makeContact({
        avatarUrl: "https://cdn.example.com/avatar.png",
        avatarSourcePlatform: "twitter",
      }),
      {
        url: "https://cdn.example.com/avatar.png",
        sourcePlatform: "twitter",
      },
    );

    expect(patch).toEqual({
      avatarUrl: "https://cdn.example.com/avatar.png",
      avatarSourcePlatform: "twitter",
      avatarUpdatedAt: 0,
      avatarOptions: [
        {
          url: "https://cdn.example.com/avatar.png",
          sourcePlatform: "twitter",
          updatedAt: 0,
        },
      ],
    });
  });

  it("returns null when incoming URL/source are unchanged and options already exist", () => {
    const patch = buildContactAvatarPatch(
      makeContact({
        avatarUrl: "https://cdn.example.com/avatar.png",
        avatarSourcePlatform: "twitter",
        avatarUpdatedAt: 4321,
        avatarOptions: [
          {
            url: "https://cdn.example.com/avatar.png",
            sourcePlatform: "twitter",
            updatedAt: 4321,
          },
        ],
      }),
      {
        url: "https://cdn.example.com/avatar.png",
        sourcePlatform: "twitter",
      },
    );

    expect(patch).toBeNull();
  });

  it("rejects non-http avatar URLs", () => {
    const patch = buildContactAvatarPatch(
      makeContact(),
      {
        url: "cued-contact-avatar://avatar/file.jpg",
        sourcePlatform: "imessage",
      },
    );

    expect(patch).toBeNull();
  });
});

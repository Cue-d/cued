import { describe, expect, it } from "vitest";
import {
  extractIdFromURN,
  normalizeConversationURN,
  normalizeMemberURN,
  isLinkedInURN,
  isConversationURN,
  isMemberURN,
  urnIdsMatch,
} from "../linkedin";

describe("LinkedIn URN utilities", () => {
  describe("extractIdFromURN", () => {
    it("extracts ID from fs_conversation URN", () => {
      expect(extractIdFromURN("urn:li:fs_conversation:12345")).toBe("12345");
    });

    it("extracts ID from fsd_conversation URN", () => {
      expect(extractIdFromURN("urn:li:fsd_conversation:conv123")).toBe(
        "conv123"
      );
    });

    it("extracts ID from messagingThread URN", () => {
      expect(extractIdFromURN("urn:li:messagingThread:thread456")).toBe(
        "thread456"
      );
    });

    it("extracts ID from member URN", () => {
      expect(extractIdFromURN("urn:li:member:ABC123")).toBe("ABC123");
    });

    it("extracts ID from fs_miniProfile URN", () => {
      expect(extractIdFromURN("urn:li:fs_miniProfile:profile789")).toBe(
        "profile789"
      );
    });

    it("extracts ID from fsd_profile URN", () => {
      expect(extractIdFromURN("urn:li:fsd_profile:user456")).toBe("user456");
    });

    it("extracts ID with parentheses (conversation IDs)", () => {
      expect(extractIdFromURN("urn:li:fs_conversation:(ABC,DEF)")).toBe(
        "(ABC,DEF)"
      );
    });

    it("returns null for non-URN strings", () => {
      expect(extractIdFromURN("not-a-urn")).toBeNull();
      expect(extractIdFromURN("")).toBeNull();
      expect(extractIdFromURN("https://linkedin.com/in/user")).toBeNull();
    });

    it("returns null for malformed URNs", () => {
      expect(extractIdFromURN("urn:li:")).toBeNull();
      expect(extractIdFromURN("urn:li:member")).toBeNull();
    });
  });

  describe("normalizeConversationURN", () => {
    it("normalizes fsd_conversation to fs_conversation", () => {
      expect(normalizeConversationURN("urn:li:fsd_conversation:123")).toBe(
        "urn:li:fs_conversation:123"
      );
    });

    it("normalizes messagingThread to fs_conversation", () => {
      expect(normalizeConversationURN("urn:li:messagingThread:456")).toBe(
        "urn:li:fs_conversation:456"
      );
    });

    it("keeps fs_conversation unchanged", () => {
      expect(normalizeConversationURN("urn:li:fs_conversation:789")).toBe(
        "urn:li:fs_conversation:789"
      );
    });

    it("preserves complex IDs", () => {
      expect(normalizeConversationURN("urn:li:fsd_conversation:(A,B,C)")).toBe(
        "urn:li:fs_conversation:(A,B,C)"
      );
    });

    it("returns non-conversation URNs unchanged", () => {
      expect(normalizeConversationURN("urn:li:member:123")).toBe(
        "urn:li:member:123"
      );
    });

    it("handles empty/null input gracefully", () => {
      expect(normalizeConversationURN("")).toBe("");
    });
  });

  describe("normalizeMemberURN", () => {
    it("normalizes fsd_profile to member", () => {
      expect(normalizeMemberURN("urn:li:fsd_profile:ABC123")).toBe(
        "urn:li:member:ABC123"
      );
    });

    it("normalizes fs_miniProfile to member", () => {
      expect(normalizeMemberURN("urn:li:fs_miniProfile:XYZ789")).toBe(
        "urn:li:member:XYZ789"
      );
    });

    it("keeps member URN unchanged", () => {
      expect(normalizeMemberURN("urn:li:member:user456")).toBe(
        "urn:li:member:user456"
      );
    });

    it("returns non-member URNs unchanged", () => {
      expect(normalizeMemberURN("urn:li:fs_conversation:123")).toBe(
        "urn:li:fs_conversation:123"
      );
    });

    it("handles empty/null input gracefully", () => {
      expect(normalizeMemberURN("")).toBe("");
    });
  });

  describe("isLinkedInURN", () => {
    it("returns true for valid LinkedIn URNs", () => {
      expect(isLinkedInURN("urn:li:member:123")).toBe(true);
      expect(isLinkedInURN("urn:li:fs_conversation:456")).toBe(true);
      expect(isLinkedInURN("urn:li:fsd_profile:ABC")).toBe(true);
    });

    it("returns false for non-LinkedIn URNs", () => {
      expect(isLinkedInURN("urn:other:123")).toBe(false);
      expect(isLinkedInURN("not-a-urn")).toBe(false);
      expect(isLinkedInURN("")).toBe(false);
    });
  });

  describe("isConversationURN", () => {
    it("returns true for conversation URNs", () => {
      expect(isConversationURN("urn:li:fs_conversation:123")).toBe(true);
      expect(isConversationURN("urn:li:fsd_conversation:456")).toBe(true);
      expect(isConversationURN("urn:li:messagingThread:789")).toBe(true);
    });

    it("returns false for non-conversation URNs", () => {
      expect(isConversationURN("urn:li:member:123")).toBe(false);
      expect(isConversationURN("urn:li:fsd_profile:ABC")).toBe(false);
      expect(isConversationURN("not-a-urn")).toBe(false);
    });
  });

  describe("isMemberURN", () => {
    it("returns true for member URNs", () => {
      expect(isMemberURN("urn:li:member:123")).toBe(true);
      expect(isMemberURN("urn:li:fs_miniProfile:456")).toBe(true);
      expect(isMemberURN("urn:li:fsd_profile:ABC")).toBe(true);
    });

    it("returns false for non-member URNs", () => {
      expect(isMemberURN("urn:li:fs_conversation:123")).toBe(false);
      expect(isMemberURN("urn:li:messagingThread:456")).toBe(false);
      expect(isMemberURN("not-a-urn")).toBe(false);
    });
  });

  describe("urnIdsMatch", () => {
    it("matches URNs with same ID but different prefixes", () => {
      expect(
        urnIdsMatch("urn:li:fsd_profile:ABC123", "urn:li:fs_miniProfile:ABC123")
      ).toBe(true);
      expect(
        urnIdsMatch("urn:li:member:ABC123", "urn:li:fsd_profile:ABC123")
      ).toBe(true);
      expect(
        urnIdsMatch(
          "urn:li:fs_conversation:123",
          "urn:li:fsd_conversation:123"
        )
      ).toBe(true);
    });

    it("does not match URNs with different IDs", () => {
      expect(urnIdsMatch("urn:li:member:123", "urn:li:member:456")).toBe(false);
      expect(
        urnIdsMatch("urn:li:fsd_profile:ABC", "urn:li:fsd_profile:XYZ")
      ).toBe(false);
    });

    it("returns false for undefined/null inputs", () => {
      expect(urnIdsMatch(undefined, "urn:li:member:123")).toBe(false);
      expect(urnIdsMatch("urn:li:member:123", undefined)).toBe(false);
      expect(urnIdsMatch(undefined, undefined)).toBe(false);
    });

    it("returns false for non-URN strings", () => {
      expect(urnIdsMatch("not-a-urn", "urn:li:member:123")).toBe(false);
      expect(urnIdsMatch("urn:li:member:123", "not-a-urn")).toBe(false);
    });

    it("matches URNs with different case (case-insensitive)", () => {
      expect(
        urnIdsMatch("urn:li:member:ABC123", "urn:li:member:abc123")
      ).toBe(true);
      expect(
        urnIdsMatch("urn:li:fsd_profile:TestUser", "urn:li:fs_miniProfile:testuser")
      ).toBe(true);
      expect(
        urnIdsMatch("urn:li:fs_conversation:ID123", "urn:li:fsd_conversation:id123")
      ).toBe(true);
    });
  });
});

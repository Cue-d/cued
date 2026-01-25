/**
 * Tests for LinkedIn InMail filtering.
 */

import { describe, it, expect } from "vitest";
import {
  isUnansweredInMail,
  isRecruiterSpam,
  shouldFilterLinkedInConversation,
  type LinkedInConversationFilterInput,
} from "../sync/filters";

describe("LinkedIn InMail Filtering", () => {
  describe("isUnansweredInMail", () => {
    it("should return true for InMail with no user reply", () => {
      expect(isUnansweredInMail(["INMAIL"], false)).toBe(true);
    });

    it("should return true for IN_MAIL category (variant)", () => {
      expect(isUnansweredInMail(["IN_MAIL"], false)).toBe(true);
    });

    it("should return false for InMail with user reply", () => {
      expect(isUnansweredInMail(["INMAIL"], true)).toBe(false);
    });

    it("should return false for non-InMail conversation", () => {
      expect(isUnansweredInMail(["PRIMARY"], false)).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isUnansweredInMail(["inmail"], false)).toBe(true);
      expect(isUnansweredInMail(["InMail"], false)).toBe(true);
    });

    it("should handle multiple categories", () => {
      expect(isUnansweredInMail(["PRIMARY", "INMAIL"], false)).toBe(true);
      expect(isUnansweredInMail(["PRIMARY", "OTHER"], false)).toBe(false);
    });
  });

  describe("isRecruiterSpam", () => {
    it("should detect 'Recruiter' in headline", () => {
      expect(isRecruiterSpam(["Senior Recruiter at Google"])).toBe(true);
    });

    it("should detect 'Talent Acquisition' variants", () => {
      expect(isRecruiterSpam(["Talent Acquisition Partner"])).toBe(true);
      expect(isRecruiterSpam(["Talent Sourcer"])).toBe(true);
      expect(isRecruiterSpam(["Talent Partner at Meta"])).toBe(true);
    });

    it("should detect 'Hiring Manager'", () => {
      expect(isRecruiterSpam(["Hiring Manager - Engineering"])).toBe(true);
    });

    it("should detect HR roles", () => {
      expect(isRecruiterSpam(["HR Business Partner"])).toBe(true);
      expect(isRecruiterSpam(["Human Resources Specialist"])).toBe(true);
      expect(isRecruiterSpam(["HR Manager at Acme Corp"])).toBe(true);
    });

    it("should detect 'Staffing' and 'Headhunter'", () => {
      expect(isRecruiterSpam(["Staffing Specialist"])).toBe(true);
      expect(isRecruiterSpam(["Executive Headhunter"])).toBe(true);
    });

    it("should detect 'People Operations'", () => {
      expect(isRecruiterSpam(["People Operations Manager"])).toBe(true);
      expect(isRecruiterSpam(["People Partner"])).toBe(true);
    });

    it("should return false for non-recruiter headlines", () => {
      expect(isRecruiterSpam(["Software Engineer at Google"])).toBe(false);
      expect(isRecruiterSpam(["CEO at Startup"])).toBe(false);
      expect(isRecruiterSpam(["Product Manager"])).toBe(false);
    });

    it("should handle empty headlines", () => {
      expect(isRecruiterSpam([""])).toBe(false);
      expect(isRecruiterSpam([])).toBe(false);
    });

    it("should check all participants", () => {
      expect(
        isRecruiterSpam([
          "Software Engineer",
          "Recruiter at Meta",
        ])
      ).toBe(true);
    });
  });

  describe("shouldFilterLinkedInConversation", () => {
    const baseInput: LinkedInConversationFilterInput = {
      entityURN: "urn:li:fs_conversation:123",
      categories: [],
      hasUserReply: false,
      participantHeadlines: [],
    };

    it("should filter unanswered InMails", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["INMAIL"],
        hasUserReply: false,
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("unanswered_inmail");
    });

    it("should not filter answered InMails", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["INMAIL"],
        hasUserReply: true,
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(false);
    });

    it("should filter recruiter InMails", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["INMAIL"],
        hasUserReply: true, // Even if answered, recruiter InMails are filtered
        participantHeadlines: ["Senior Recruiter at Google"],
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("recruiter_inmail");
    });

    it("should not filter recruiter messages from non-InMail conversations", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["PRIMARY"],
        hasUserReply: true,
        participantHeadlines: ["Recruiter at Meta"],
      };
      const result = shouldFilterLinkedInConversation(input);
      // Recruiter filter only applies to InMails
      expect(result.filtered).toBe(false);
    });

    it("should not filter regular conversations", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["PRIMARY"],
        hasUserReply: false,
        participantHeadlines: ["Software Engineer at Acme"],
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(false);
    });

    it("should handle empty categories", () => {
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: [],
        hasUserReply: false,
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(false);
    });

    it("should prioritize unanswered InMail filter over recruiter filter", () => {
      // If both would match, unanswered_inmail should be the reason
      const input: LinkedInConversationFilterInput = {
        ...baseInput,
        categories: ["INMAIL"],
        hasUserReply: false,
        participantHeadlines: ["Recruiter at Meta"],
      };
      const result = shouldFilterLinkedInConversation(input);
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("unanswered_inmail");
    });
  });
});

/**
 * Tests for message filtering system.
 *
 * These are pure function tests - no Convex backend needed.
 */

import { describe, expect, it } from "vitest";
import {
  isOtpMessage,
  isAutomatedSender,
  hasUnsubscribeLanguage,
  applyFilters,
  applyFiltersBatch,
  type FilterableMessage,
} from "../sync/filters";

describe("filters", () => {
  describe("isOtpMessage", () => {
    it("detects OTP codes with verification keywords", () => {
      expect(isOtpMessage("Your verification code is 123456")).toBe(true);
      expect(isOtpMessage("Your OTP is 1234")).toBe(true);
      expect(isOtpMessage("Enter code: 12345678 to verify your account")).toBe(true);
      expect(isOtpMessage("Your 2FA code is 456789")).toBe(true);
      expect(isOtpMessage("Security code: 9876")).toBe(true);
    });

    it("detects OTP codes with space-separated digits", () => {
      expect(isOtpMessage("Your code is 12 34 56")).toBe(true);
      expect(isOtpMessage("PIN: 12-34-56-78")).toBe(true);
    });

    it("does not match regular messages without OTP keywords", () => {
      expect(isOtpMessage("Hello, my number is 123456")).toBe(false);
      expect(isOtpMessage("Order #12345678 confirmed")).toBe(false);
    });

    it("does not match messages with keywords but no code", () => {
      expect(isOtpMessage("Please verify your account")).toBe(false);
      expect(isOtpMessage("Enter your verification code")).toBe(false);
    });

    it("does not match codes that are too short or too long", () => {
      expect(isOtpMessage("Code: 12")).toBe(false); // Too short
      expect(isOtpMessage("Code: 123456789012")).toBe(false); // Too long
    });
  });

  describe("isAutomatedSender", () => {
    it("detects no-reply email addresses", () => {
      expect(isAutomatedSender("noreply@example.com")).toBe(true);
      expect(isAutomatedSender("no-reply@company.com")).toBe(true);
      expect(isAutomatedSender("donotreply@service.io")).toBe(true);
    });

    it("detects marketing/notification emails", () => {
      expect(isAutomatedSender("newsletter@example.com")).toBe(true);
      expect(isAutomatedSender("notifications@app.com")).toBe(true);
      expect(isAutomatedSender("updates@service.com")).toBe(true);
      expect(isAutomatedSender("marketing@brand.com")).toBe(true);
      expect(isAutomatedSender("alerts@bank.com")).toBe(true);
    });

    it("detects system/mailer emails", () => {
      expect(isAutomatedSender("mailer-daemon@server.com")).toBe(true);
      expect(isAutomatedSender("postmaster@domain.com")).toBe(true);
      expect(isAutomatedSender("automated@system.com")).toBe(true);
    });

    it("detects phone short codes (5-6 digits)", () => {
      expect(isAutomatedSender("12345")).toBe(true);
      expect(isAutomatedSender("123456")).toBe(true);
      expect(isAutomatedSender("98765")).toBe(true);
    });

    it("does not match regular emails", () => {
      expect(isAutomatedSender("john@example.com")).toBe(false);
      expect(isAutomatedSender("support-team@company.com")).toBe(false);
      expect(isAutomatedSender("hello@startup.io")).toBe(false);
    });

    it("does not match regular phone numbers", () => {
      expect(isAutomatedSender("+15551234567")).toBe(false);
      expect(isAutomatedSender("555-123-4567")).toBe(false);
    });

    it("handles undefined/empty input", () => {
      expect(isAutomatedSender(undefined)).toBe(false);
      expect(isAutomatedSender("")).toBe(false);
    });
  });

  describe("hasUnsubscribeLanguage", () => {
    it("detects STOP opt-out patterns", () => {
      expect(hasUnsubscribeLanguage("Reply STOP to unsubscribe")).toBe(true);
      expect(hasUnsubscribeLanguage("Text STOP to opt out")).toBe(true);
      expect(hasUnsubscribeLanguage("Reply END to stop")).toBe(true);
    });

    it("detects unsubscribe patterns", () => {
      expect(hasUnsubscribeLanguage("Click here to unsubscribe")).toBe(true);
      expect(hasUnsubscribeLanguage("To opt-out, click below")).toBe(true);
      expect(hasUnsubscribeLanguage("To stop receiving these messages")).toBe(true);
    });

    it("is case insensitive", () => {
      expect(hasUnsubscribeLanguage("REPLY STOP TO OPT-OUT")).toBe(true);
      expect(hasUnsubscribeLanguage("reply stop to opt-out")).toBe(true);
    });

    it("does not match regular messages", () => {
      expect(hasUnsubscribeLanguage("Stop by the office tomorrow")).toBe(false);
      expect(hasUnsubscribeLanguage("Let's end this project")).toBe(false);
    });
  });

  describe("applyFilters", () => {
    const createMessage = (
      overrides: Partial<FilterableMessage> = {}
    ): FilterableMessage => ({
      text: "Hello, how are you?",
      senderHandle: "friend@example.com",
      isFromKnownContact: true,
      platform: "imessage",
      ...overrides,
    });

    it("returns filtered=false for normal messages", () => {
      const result = applyFilters(createMessage());
      expect(result.filtered).toBe(false);
    });

    it("filters OTP messages", () => {
      const result = applyFilters(
        createMessage({ text: "Your verification code is 123456" })
      );
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("otp_verification_code");
      expect(result.ruleName).toBe("otp_code");
    });

    it("filters automated senders", () => {
      const result = applyFilters(
        createMessage({ senderHandle: "noreply@company.com" })
      );
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("automated_sender");
    });

    it("filters marketing messages with unsubscribe", () => {
      const result = applyFilters(
        createMessage({ text: "50% off sale! Reply STOP to unsubscribe" })
      );
      expect(result.filtered).toBe(true);
      expect(result.reason).toBe("marketing_unsubscribe");
    });

    it("applies filters to all platforms when platform list is empty", () => {
      const platforms = ["imessage", "gmail", "slack", "linkedin"] as const;

      for (const platform of platforms) {
        const result = applyFilters(
          createMessage({
            text: "Your code is 123456",
            platform,
          })
        );
        expect(result.filtered).toBe(true);
      }
    });
  });

  describe("applyFiltersBatch", () => {
    it("filters batch of messages and returns stats", () => {
      const messages: FilterableMessage[] = [
        { text: "Hello!", platform: "imessage" },
        { text: "Code: 123456", platform: "imessage" },
        { text: "Normal message", platform: "gmail" },
        { text: "Reply STOP to unsubscribe", platform: "gmail" },
        { text: "Another normal one", platform: "slack" },
      ];

      const result = applyFiltersBatch(messages);

      expect(result.passed.length).toBe(3);
      expect(result.filtered).toBe(2);
      expect(result.reasons).toEqual({
        otp_verification_code: 1,
        marketing_unsubscribe: 1,
      });
    });

    it("returns all messages when none are filtered", () => {
      const messages: FilterableMessage[] = [
        { text: "Hey!", platform: "imessage" },
        { text: "What's up?", platform: "gmail" },
      ];

      const result = applyFiltersBatch(messages);

      expect(result.passed.length).toBe(2);
      expect(result.filtered).toBe(0);
      expect(result.reasons).toEqual({});
    });

    it("handles empty array", () => {
      const result = applyFiltersBatch([]);

      expect(result.passed).toEqual([]);
      expect(result.filtered).toBe(0);
      expect(result.reasons).toEqual({});
    });
  });
});

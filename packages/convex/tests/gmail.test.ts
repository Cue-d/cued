/**
 * Tests for Gmail label-based filtering.
 */

import { describe, expect, it } from "vitest";
import {
  shouldFilterByLabel,
  shouldFilterGmailEmail,
  isNewsletterOrAutomated,
  type GmailEmailInput,
} from "../convex/sync/gmail";

// Helper to create test emails
function createEmail(overrides: Partial<GmailEmailInput> = {}): GmailEmailInput {
  return {
    id: "msg-123",
    sender: "test@example.com",
    date: new Date().toISOString(),
    subject: "Test email",
    attachments: [],
    threadId: "thread-123",
    ...overrides,
  };
}

describe("shouldFilterByLabel", () => {
  it("should exclude emails with CATEGORY_PROMOTIONS label", () => {
    const email = createEmail({ labelIds: ["CATEGORY_PROMOTIONS", "INBOX"] });
    expect(shouldFilterByLabel(email)).toBe(true);
  });

  it("should exclude emails with CATEGORY_SOCIAL label", () => {
    const email = createEmail({ labelIds: ["CATEGORY_SOCIAL", "UNREAD"] });
    expect(shouldFilterByLabel(email)).toBe(true);
  });

  it("should exclude emails with CATEGORY_UPDATES label", () => {
    const email = createEmail({ labelIds: ["INBOX", "CATEGORY_UPDATES"] });
    expect(shouldFilterByLabel(email)).toBe(true);
  });

  it("should exclude emails with CATEGORY_FORUMS label", () => {
    const email = createEmail({ labelIds: ["CATEGORY_FORUMS"] });
    expect(shouldFilterByLabel(email)).toBe(true);
  });

  it("should include emails with INBOX label", () => {
    const email = createEmail({ labelIds: ["INBOX", "UNREAD"] });
    expect(shouldFilterByLabel(email)).toBe(false);
  });

  it("should include emails with SENT label", () => {
    const email = createEmail({ labelIds: ["SENT"] });
    expect(shouldFilterByLabel(email)).toBe(false);
  });

  it("should fall through for emails without relevant labels", () => {
    const email = createEmail({ labelIds: ["STARRED", "IMPORTANT"] });
    expect(shouldFilterByLabel(email)).toBe("fallthrough");
  });

  it("should fall through for emails without any labels", () => {
    const email = createEmail({ labelIds: [] });
    expect(shouldFilterByLabel(email)).toBe("fallthrough");
  });

  it("should fall through for emails with undefined labelIds", () => {
    const email = createEmail({ labelIds: undefined });
    expect(shouldFilterByLabel(email)).toBe("fallthrough");
  });
});

describe("isNewsletterOrAutomated", () => {
  it("should detect noreply sender", () => {
    const email = createEmail({ sender: "noreply@company.com" });
    expect(isNewsletterOrAutomated(email)).toBe(true);
  });

  it("should detect no-reply sender", () => {
    const email = createEmail({ sender: "no-reply@service.io" });
    expect(isNewsletterOrAutomated(email)).toBe(true);
  });

  it("should detect newsletter sender", () => {
    const email = createEmail({ sender: "newsletter@media.com" });
    expect(isNewsletterOrAutomated(email)).toBe(true);
  });

  it("should detect newsletter subject pattern", () => {
    const email = createEmail({
      sender: "editor@news.com",
      subject: "[Newsletter] Weekly Updates",
    });
    expect(isNewsletterOrAutomated(email)).toBe(true);
  });

  it("should detect weekly digest in subject", () => {
    const email = createEmail({
      sender: "digest@company.com",
      subject: "Your weekly roundup for January",
    });
    expect(isNewsletterOrAutomated(email)).toBe(true);
  });

  it("should not filter personal email", () => {
    const email = createEmail({
      sender: "John Smith <john@example.com>",
      subject: "Re: Meeting tomorrow",
    });
    expect(isNewsletterOrAutomated(email)).toBe(false);
  });
});

describe("shouldFilterGmailEmail (combined)", () => {
  it("should filter promotional emails even if sender looks personal", () => {
    const email = createEmail({
      sender: "friend@gmail.com",
      subject: "Check this out",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    expect(shouldFilterGmailEmail(email)).toBe(true);
  });

  it("should include inbox emails even if sender looks automated", () => {
    const email = createEmail({
      sender: "notifications@important-service.com",
      subject: "Action required",
      labelIds: ["INBOX", "IMPORTANT"],
    });
    expect(shouldFilterGmailEmail(email)).toBe(false);
  });

  it("should fall back to content filter when no labels", () => {
    const email = createEmail({
      sender: "newsletter@spam.com",
      subject: "[Digest] Your weekly news",
    });
    expect(shouldFilterGmailEmail(email)).toBe(true);
  });

  it("should include personal email without labels", () => {
    const email = createEmail({
      sender: "colleague@work.com",
      subject: "Project update",
    });
    expect(shouldFilterGmailEmail(email)).toBe(false);
  });
});

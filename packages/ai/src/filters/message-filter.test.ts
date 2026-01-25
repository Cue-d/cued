import { describe, it, expect } from "vitest";
import {
  isShortCode,
  isOtpMessage,
  isDeliveryNotification,
  isAccountSecuritySpam,
  hasUnsubscribe,
  isCarrierNotification,
  isUrgencySpam,
  isPromotional,
  isBankAlert,
  shouldSkipLlmAnalysis,
} from "./message-filter";

describe("isShortCode", () => {
  it("detects 5-digit short codes", () => {
    expect(isShortCode("12345").shouldSkip).toBe(true);
    expect(isShortCode("72345").shouldSkip).toBe(true);
  });

  it("detects 6-digit short codes", () => {
    expect(isShortCode("123456").shouldSkip).toBe(true);
  });

  it("ignores regular phone numbers", () => {
    expect(isShortCode("+15551234567").shouldSkip).toBe(false);
    expect(isShortCode("5551234567").shouldSkip).toBe(false);
  });

  it("ignores non-numeric identifiers", () => {
    expect(isShortCode("john@example.com").shouldSkip).toBe(false);
    expect(isShortCode("John Doe").shouldSkip).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isShortCode(null).shouldSkip).toBe(false);
    expect(isShortCode(undefined).shouldSkip).toBe(false);
  });
});

describe("isOtpMessage", () => {
  it("detects verification codes", () => {
    expect(isOtpMessage("Your verification code is 123456").shouldSkip).toBe(true);
    expect(isOtpMessage("G-123456 is your Google verification code").shouldSkip).toBe(true);
    expect(isOtpMessage("OTP: 4521").shouldSkip).toBe(true);
    expect(isOtpMessage("Your PIN is 5678").shouldSkip).toBe(true);
    expect(isOtpMessage("Authentication code: 789012").shouldSkip).toBe(true);
  });

  it("ignores normal messages with numbers", () => {
    expect(isOtpMessage("Let's meet at 5pm").shouldSkip).toBe(false);
    expect(isOtpMessage("I have 3 tickets for the show").shouldSkip).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isOtpMessage(null).shouldSkip).toBe(false);
    expect(isOtpMessage(undefined).shouldSkip).toBe(false);
  });
});

describe("isDeliveryNotification", () => {
  it("detects delivery notifications with links", () => {
    expect(
      isDeliveryNotification("UPS: Your package is out for delivery. Track: https://ups.com/track")
        .shouldSkip
    ).toBe(true);
    expect(
      isDeliveryNotification("Your Amazon shipment has shipped. View at www.amazon.com/orders")
        .shouldSkip
    ).toBe(true);
  });

  it("detects delivery notifications with tracking numbers", () => {
    expect(
      isDeliveryNotification("FedEx: Package delivered. Tracking #1Z999AA10123456784").shouldSkip
    ).toBe(true);
  });

  it("ignores casual mentions of delivery", () => {
    expect(isDeliveryNotification("Did you get the package I sent?").shouldSkip).toBe(false);
    expect(isDeliveryNotification("The delivery guy was nice").shouldSkip).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isDeliveryNotification(null).shouldSkip).toBe(false);
  });
});

describe("isAccountSecuritySpam", () => {
  it("detects phishing from non-contacts", () => {
    expect(
      isAccountSecuritySpam("Your account has been locked. Click here to verify", false).shouldSkip
    ).toBe(true);
    expect(
      isAccountSecuritySpam("Unusual activity detected. Confirm your identity", false).shouldSkip
    ).toBe(true);
  });

  it("does not filter contacts", () => {
    expect(
      isAccountSecuritySpam("Your account has been locked. Click here to verify", true).shouldSkip
    ).toBe(false);
  });
});

describe("hasUnsubscribe", () => {
  it("detects unsubscribe messages", () => {
    expect(hasUnsubscribe("Reply STOP to unsubscribe").shouldSkip).toBe(true);
    expect(hasUnsubscribe("Text STOP to cancel").shouldSkip).toBe(true);
    expect(hasUnsubscribe("Opt-out: reply END").shouldSkip).toBe(true);
  });

  it("ignores normal messages", () => {
    expect(hasUnsubscribe("Please stop by the office").shouldSkip).toBe(false);
  });
});

describe("isCarrierNotification", () => {
  it("detects carrier names", () => {
    expect(isCarrierNotification("AT&T Wireless").shouldSkip).toBe(true);
    expect(isCarrierNotification("Verizon Msg").shouldSkip).toBe(true);
    expect(isCarrierNotification("T-Mobile").shouldSkip).toBe(true);
    expect(isCarrierNotification("Xfinity").shouldSkip).toBe(true);
  });

  it("ignores other names", () => {
    expect(isCarrierNotification("John Doe").shouldSkip).toBe(false);
    expect(isCarrierNotification("Jane Smith").shouldSkip).toBe(false);
  });
});

describe("isUrgencySpam", () => {
  it("detects urgency spam from non-contacts", () => {
    expect(isUrgencySpam("Act now! Limited offer!", false).shouldSkip).toBe(true);
    expect(isUrgencySpam("Expires in 24 hours", false).shouldSkip).toBe(true);
    expect(isUrgencySpam("URGENT: Final notice", false).shouldSkip).toBe(true);
  });

  it("does not filter contacts", () => {
    expect(isUrgencySpam("This is urgent! Call me!", true).shouldSkip).toBe(false);
  });
});

describe("isPromotional", () => {
  it("detects promotional messages from non-contacts", () => {
    expect(isPromotional("50% off everything today!", false).shouldSkip).toBe(true);
    expect(isPromotional("Flash sale starts now!", false).shouldSkip).toBe(true);
    expect(isPromotional("Use promo code SAVE20", false).shouldSkip).toBe(true);
  });

  it("does not filter contacts", () => {
    expect(isPromotional("There's a great deal at the store", true).shouldSkip).toBe(false);
  });
});

describe("isBankAlert", () => {
  it("detects bank alerts from non-contacts", () => {
    expect(
      isBankAlert("Chase: Purchase of $47.83 at Amazon on card ending 1234", false).shouldSkip
    ).toBe(true);
    expect(isBankAlert("Direct deposit of $2,500.00 received", false).shouldSkip).toBe(true);
    expect(isBankAlert("Transaction alert: $100.00 withdrawal", false).shouldSkip).toBe(true);
  });

  it("does not filter contacts", () => {
    expect(isBankAlert("I made a payment of $50", true).shouldSkip).toBe(false);
  });
});

describe("shouldSkipLlmAnalysis", () => {
  it("returns shouldSkip=false for normal messages", () => {
    const result = shouldSkipLlmAnalysis({
      identifier: "+15551234567",
      text: "Hey, want to grab lunch tomorrow?",
      personName: "John Doe",
      isContact: true,
    });
    expect(result.shouldSkip).toBe(false);
  });

  it("filters short code senders first", () => {
    const result = shouldSkipLlmAnalysis({
      identifier: "12345",
      text: "Normal message text",
    });
    expect(result.shouldSkip).toBe(true);
    expect(result.reason).toBe("short_code_sender");
  });

  it("filters OTP messages", () => {
    const result = shouldSkipLlmAnalysis({
      identifier: "+15551234567",
      text: "Your verification code is 123456",
    });
    expect(result.shouldSkip).toBe(true);
    expect(result.reason).toBe("otp_verification_code");
  });

  it("filters unsubscribe messages even for contacts", () => {
    const result = shouldSkipLlmAnalysis({
      text: "Special offer! Reply STOP to unsubscribe",
      isContact: true,
    });
    expect(result.shouldSkip).toBe(true);
    expect(result.reason).toBe("marketing_with_unsubscribe");
  });

  it("does not filter security messages from contacts", () => {
    const result = shouldSkipLlmAnalysis({
      text: "Your account may have been compromised. Verify your identity.",
      isContact: true,
    });
    expect(result.shouldSkip).toBe(false);
  });

  it("filters security phishing from non-contacts", () => {
    const result = shouldSkipLlmAnalysis({
      text: "Your account has been suspended. Click here to verify.",
      isContact: false,
    });
    expect(result.shouldSkip).toBe(true);
    expect(result.reason).toBe("account_security_phishing");
  });

  it("returns confidence scores", () => {
    const otpResult = shouldSkipLlmAnalysis({ text: "Your code is 123456" });
    expect(otpResult.confidence).toBeGreaterThan(0.9);

    const promoResult = shouldSkipLlmAnalysis({
      text: "50% off sale!",
      isContact: false,
    });
    expect(promoResult.confidence).toBeLessThan(0.9);
  });
});

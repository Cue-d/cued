/**
 * Message filters to skip LLM analysis for obviously non-actionable messages.
 *
 * These filters have HIGH PRECISION - we prefer to let borderline cases through
 * to the LLM rather than accidentally filter real conversations.
 */

/** Reasons why a message was skipped from LLM analysis */
export type SkipReason =
  | "short_code_sender"
  | "otp_verification_code"
  | "delivery_tracking"
  | "account_security_phishing"
  | "marketing_with_unsubscribe"
  | "carrier_notification"
  | "urgency_spam_unknown_sender"
  | "promotional_unknown_sender"
  | "bank_transaction_alert";

/** Result of applying message filters */
export interface FilterResult {
  shouldSkip: boolean;
  reason?: SkipReason;
  confidence: number;
}

// =============================================================================
// REGEX PATTERNS
// =============================================================================

/** Short code: 5-6 digit numbers used by automated SMS systems */
const SHORT_CODE_PATTERN = /^\d{5,6}$/;

/** OTP/2FA: Digit sequences (4-8 digits) near verification keywords */
const OTP_PATTERN =
  /(?:\b\d{4,8}\b.{0,30}?(code|verify|verification|otp|authentication|pin|confirm)|(code|verify|verification|otp|authentication|pin).{0,30}?\b\d{4,8}\b)/i;

/** Delivery/shipping: Package tracking and delivery notifications */
const DELIVERY_PATTERN =
  /(tracking|shipped|delivered|delivery|package|parcel|ups|fedex|usps|dhl|amazon|out for delivery|estimated arrival|shipment)/i;

/** Account security phishing: Fake security alerts trying to steal credentials */
const ACCOUNT_SECURITY_PATTERN =
  /(locked|suspended|compromised|unusual activity|unauthorized|security alert|verify your).{0,50}(verify|confirm|click|link|update|login)/i;

/** Unsubscribe/opt-out: Marketing messages with opt-out instructions */
const UNSUBSCRIBE_PATTERN =
  /(reply\s*stop|text\s*stop|stop\s*to\s*(cancel|end|opt|unsubscribe)|unsubscribe|opt.?out|to\s*stop\s*receiving)/i;

/** Carrier names: Mobile carrier and ISP notifications */
const CARRIER_NAMES = new Set([
  "at&t",
  "verizon",
  "t-mobile",
  "tmobile",
  "sprint",
  "visible",
  "mint",
  "cricket",
  "metro",
  "boost",
  "us cellular",
  "xfinity",
  "comcast",
]);

/** Urgency spam: Pressure tactics to get immediate action */
const URGENCY_PATTERN =
  /(act now|expires? in|limited time|24 hours?|48 hours?|immediately|urgent|last chance|final notice|don'?t miss)/i;

/** Promotional: Sales, discounts, and marketing offers */
const PROMOTIONAL_PATTERN =
  /(\d+%\s*off|flash sale|deal|discount|coupon|promo\s*code|free shipping|clearance|buy one get|bogo|special offer)/i;

/** Bank/transaction alerts: Automated banking notifications */
const BANK_ALERT_PATTERN =
  /(card ending|transaction.{0,20}\$\d|purchase of \$|direct deposit|withdrawal.{0,20}\$|balance.{0,20}\$|payment.{0,20}(received|processed|due))/i;

/** Tracking number pattern (10-30 alphanumeric characters) */
const TRACKING_NUMBER_PATTERN = /\b[A-Z0-9]{10,30}\b/;

// =============================================================================
// INDIVIDUAL FILTERS
// =============================================================================

function noSkip(): FilterResult {
  return { shouldSkip: false, confidence: 0 };
}

/** Filter short code senders (5-6 digit numbers) */
export function isShortCode(identifier?: string | null): FilterResult {
  if (identifier && SHORT_CODE_PATTERN.test(identifier.trim())) {
    return { shouldSkip: true, reason: "short_code_sender", confidence: 0.99 };
  }
  return noSkip();
}

/** Filter 2FA/OTP verification codes */
export function isOtpMessage(text?: string | null): FilterResult {
  if (text && OTP_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "otp_verification_code", confidence: 0.95 };
  }
  return noSkip();
}

/** Filter delivery/shipping notifications (requires link or tracking number) */
export function isDeliveryNotification(text?: string | null): FilterResult {
  if (!text) return noSkip();

  if (DELIVERY_PATTERN.test(text)) {
    const textLower = text.toLowerCase();
    const hasLink = textLower.includes("http") || textLower.includes("www.");
    const hasTracking = TRACKING_NUMBER_PATTERN.test(text);

    if (hasLink || hasTracking) {
      return { shouldSkip: true, reason: "delivery_tracking", confidence: 0.9 };
    }
  }
  return noSkip();
}

/** Filter phishing attempts about account security (non-contacts only) */
export function isAccountSecuritySpam(
  text?: string | null,
  isContact = false
): FilterResult {
  if (isContact) return noSkip();
  if (text && ACCOUNT_SECURITY_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "account_security_phishing", confidence: 0.95 };
  }
  return noSkip();
}

/** Filter marketing messages with unsubscribe text */
export function hasUnsubscribe(text?: string | null): FilterResult {
  if (text && UNSUBSCRIBE_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "marketing_with_unsubscribe", confidence: 0.98 };
  }
  return noSkip();
}

/** Filter carrier/service provider notifications */
export function isCarrierNotification(personName?: string | null): FilterResult {
  if (personName) {
    const nameLower = personName.toLowerCase();
    for (const carrier of CARRIER_NAMES) {
      if (nameLower.includes(carrier)) {
        return { shouldSkip: true, reason: "carrier_notification", confidence: 0.95 };
      }
    }
  }
  return noSkip();
}

/** Filter urgency-based spam (non-contacts only) */
export function isUrgencySpam(
  text?: string | null,
  isContact = false
): FilterResult {
  if (isContact) return noSkip();
  if (text && URGENCY_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "urgency_spam_unknown_sender", confidence: 0.8 };
  }
  return noSkip();
}

/** Filter promotional messages (non-contacts only) */
export function isPromotional(
  text?: string | null,
  isContact = false
): FilterResult {
  if (isContact) return noSkip();
  if (text && PROMOTIONAL_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "promotional_unknown_sender", confidence: 0.75 };
  }
  return noSkip();
}

/** Filter automated banking notifications (non-contacts only) */
export function isBankAlert(
  text?: string | null,
  isContact = false
): FilterResult {
  if (isContact) return noSkip();
  if (text && BANK_ALERT_PATTERN.test(text)) {
    return { shouldSkip: true, reason: "bank_transaction_alert", confidence: 0.9 };
  }
  return noSkip();
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

export interface FilterInput {
  identifier?: string | null;
  text?: string | null;
  personName?: string | null;
  isContact?: boolean;
}

/**
 * Main entry point: determine if a message should skip LLM analysis.
 *
 * Filters are ordered by confidence (highest first) and short-circuit on match.
 * This ensures we catch the most obvious spam first while minimizing false positives.
 *
 * IMPORTANT: Contacts are trusted and bypass most content filters. Only universal
 * spam signals (short codes, unsubscribe) are applied to contacts.
 */
export function shouldSkipLlmAnalysis(input: FilterInput): FilterResult {
  const { identifier, text, personName, isContact = false } = input;

  // Tier 1: Sender-based (very high confidence, applies to all)
  let result = isShortCode(identifier);
  if (result.shouldSkip) return result;

  // Tier 2: Universal content filters (applies to all senders)
  result = isOtpMessage(text);
  if (result.shouldSkip) return result;

  result = hasUnsubscribe(text);
  if (result.shouldSkip) return result;

  result = isCarrierNotification(personName);
  if (result.shouldSkip) return result;

  result = isDeliveryNotification(text);
  if (result.shouldSkip) return result;

  // Tier 3: Non-contact only filters (high confidence)
  result = isAccountSecuritySpam(text, isContact);
  if (result.shouldSkip) return result;

  result = isBankAlert(text, isContact);
  if (result.shouldSkip) return result;

  // Tier 4: Lower confidence (only for non-contacts)
  result = isUrgencySpam(text, isContact);
  if (result.shouldSkip) return result;

  result = isPromotional(text, isContact);
  if (result.shouldSkip) return result;

  return noSkip();
}

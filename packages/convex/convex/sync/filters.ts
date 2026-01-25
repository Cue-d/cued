/**
 * Message filtering system for sync operations.
 * Provides rules to filter out spam, OTP codes, and automated messages
 * before they are stored or analyzed.
 */

// ============================================================================
// Filter Rule Interface
// ============================================================================

export interface FilterRule {
  /** Unique name for the filter */
  name: string;
  /** Platforms this filter applies to (empty = all platforms) */
  platforms: Array<"imessage" | "gmail" | "slack" | "linkedin">;
  /** Test function - returns true if message should be FILTERED (skipped) */
  test: (message: FilterableMessage) => boolean;
  /** Reason code for why message was filtered */
  reason: string;
}

export interface FilterableMessage {
  text: string;
  senderName?: string;
  senderHandle?: string; // email, phone, etc.
  isFromKnownContact?: boolean;
  platform: "imessage" | "gmail" | "slack" | "linkedin";
}

export interface FilterResult {
  filtered: boolean;
  reason?: string;
  ruleName?: string;
}

// ============================================================================
// OTP Detection
// ============================================================================

/**
 * Detects OTP/verification code messages.
 * Pattern: 4-8 digit code near verification keywords.
 * More restrictive to avoid false positives on order confirmations.
 */
export function isOtpMessage(text: string): boolean {
  const normalized = text.toLowerCase();

  // OTP-specific keywords (more restrictive - excludes generic "confirm")
  const otpKeywords = [
    "verification code",
    "verify code",
    "your code",
    "code is",
    "code:",
    "otp",
    "one-time",
    "one time",
    "2fa",
    "two-factor",
    "two factor",
    "authentication code",
    "passcode",
    "security code",
    "login code",
    "sign in code",
    "signin code",
    "pin:",
    "pin is",
  ];

  // Check for presence of OTP keywords
  const hasOtpKeyword = otpKeywords.some((kw) => normalized.includes(kw));
  if (!hasOtpKeyword) return false;

  // Check for 4-8 digit code (standalone or space-separated)
  // Matches: "123456", "1234", "12 34 56", "12-34-56"
  const codePattern = /\b\d[\d\s-]{2,7}\d\b/;
  return codePattern.test(text);
}

// ============================================================================
// Automated Sender Detection
// ============================================================================

/**
 * Detects automated/no-reply senders.
 * Checks email patterns and phone short codes.
 */
export function isAutomatedSender(senderHandle?: string): boolean {
  if (!senderHandle) return false;

  const normalized = senderHandle.toLowerCase();

  // Email patterns for automated senders
  const automatedEmailPrefixes = [
    "noreply",
    "no-reply",
    "donotreply",
    "do-not-reply",
    "newsletter",
    "notifications",
    "updates",
    "marketing",
    "promo",
    "deals",
    "info@",
    "mailer-daemon",
    "postmaster",
    "alerts",
    "system",
    "automated",
    "bounce",
  ];

  // Check email prefixes
  if (normalized.includes("@")) {
    const localPart = normalized.split("@")[0];
    return automatedEmailPrefixes.some(
      (prefix) => localPart.includes(prefix) || localPart === prefix.replace("@", "")
    );
  }

  // Check for phone short codes (5-6 digits, typically used by businesses)
  const isShortCode = /^\d{5,6}$/.test(senderHandle.replace(/[^0-9]/g, ""));
  return isShortCode;
}

// ============================================================================
// Universal Filters
// ============================================================================

/**
 * Detects messages with unsubscribe/opt-out language.
 * Strong indicator of marketing/automated messages.
 */
export function hasUnsubscribeLanguage(text: string): boolean {
  const normalized = text.toLowerCase();

  const unsubscribePatterns = [
    "reply stop",
    "text stop",
    "reply end",
    "text end",
    "opt-out",
    "opt out",
    "unsubscribe",
    "to stop receiving",
    "to unsubscribe",
  ];

  return unsubscribePatterns.some((p) => normalized.includes(p));
}

// ============================================================================
// Filter Rules Registry
// ============================================================================

const UNIVERSAL_FILTERS: FilterRule[] = [
  {
    name: "otp_code",
    platforms: [], // All platforms
    test: (msg) => isOtpMessage(msg.text),
    reason: "otp_verification_code",
  },
  {
    name: "automated_sender",
    platforms: [], // All platforms
    test: (msg) => isAutomatedSender(msg.senderHandle),
    reason: "automated_sender",
  },
  {
    name: "unsubscribe",
    platforms: [], // All platforms
    test: (msg) => hasUnsubscribeLanguage(msg.text),
    reason: "marketing_unsubscribe",
  },
];

// ============================================================================
// Filter Application
// ============================================================================

/**
 * Apply all applicable filters to a message.
 * Returns the first matching filter result, or { filtered: false } if no filters match.
 */
export function applyFilters(message: FilterableMessage): FilterResult {
  for (const rule of UNIVERSAL_FILTERS) {
    // Skip if rule doesn't apply to this platform
    if (rule.platforms.length > 0 && !rule.platforms.includes(message.platform)) {
      continue;
    }

    // Test the rule
    if (rule.test(message)) {
      return {
        filtered: true,
        reason: rule.reason,
        ruleName: rule.name,
      };
    }
  }

  return { filtered: false };
}

/**
 * Apply filters to a batch of messages.
 * Returns messages that passed all filters and a count of filtered messages.
 */
export function applyFiltersBatch<T extends FilterableMessage>(
  messages: T[]
): { passed: T[]; filtered: number; reasons: Record<string, number> } {
  const passed: T[] = [];
  let filtered = 0;
  const reasons: Record<string, number> = {};

  for (const msg of messages) {
    const result = applyFilters(msg);
    if (result.filtered) {
      filtered++;
      const reason = result.reason ?? "unknown";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    } else {
      passed.push(msg);
    }
  }

  return { passed, filtered, reasons };
}

/**
 * Get all registered filter rules.
 * Useful for debugging and documentation.
 */
export function getAllFilterRules(): FilterRule[] {
  return [...UNIVERSAL_FILTERS];
}

// ============================================================================
// LinkedIn InMail Filtering
// ============================================================================

export interface LinkedInConversationFilterInput {
  /** Conversation URN (entityURN) */
  entityURN: string;
  /** LinkedIn categories (e.g., ["INMAIL"]) */
  categories: string[];
  /** Whether user has replied to this conversation */
  hasUserReply: boolean;
  /** Participant headlines (for recruiter detection) */
  participantHeadlines: string[];
}

export interface LinkedInConversationFilterResult {
  filtered: boolean;
  reason?: string;
}

/**
 * Check if conversation is an unanswered InMail.
 * InMails where user hasn't replied are filtered.
 */
export function isUnansweredInMail(
  categories: string[],
  hasUserReply: boolean
): boolean {
  const isInMail = categories.some(
    (c) => c.toUpperCase() === "INMAIL" || c.toUpperCase() === "IN_MAIL"
  );
  return isInMail && !hasUserReply;
}

/**
 * Check if any participant appears to be a recruiter based on headline.
 * Common patterns: "Recruiter", "Talent Acquisition", "Hiring Manager", etc.
 */
export function isRecruiterSpam(participantHeadlines: string[]): boolean {
  const recruiterPatterns = [
    /recruiter/i,
    /talent\s*(acquisition|partner|sourcer)/i,
    /hiring\s*manager/i,
    /staffing/i,
    /headhunter/i,
    /human\s*resources?\s*(specialist|partner|manager)?/i,
    /hr\s*(specialist|partner|manager|business\s*partner)/i,
    /people\s*(operations|partner)/i,
  ];

  return participantHeadlines.some((headline) => {
    if (!headline) return false;
    return recruiterPatterns.some((pattern) => pattern.test(headline));
  });
}

/**
 * Apply LinkedIn-specific conversation filters.
 * Returns whether the conversation should be filtered (skipped).
 */
export function shouldFilterLinkedInConversation(
  input: LinkedInConversationFilterInput
): LinkedInConversationFilterResult {
  // Filter 1: Unanswered InMails
  if (isUnansweredInMail(input.categories, input.hasUserReply)) {
    return { filtered: true, reason: "unanswered_inmail" };
  }

  // Filter 2: Recruiter spam (only for InMails where user hasn't engaged)
  // We only apply recruiter filter to InMails to avoid filtering legitimate connections
  const isInMail = input.categories.some(
    (c) => c.toUpperCase() === "INMAIL" || c.toUpperCase() === "IN_MAIL"
  );
  if (isInMail && isRecruiterSpam(input.participantHeadlines)) {
    return { filtered: true, reason: "recruiter_inmail" };
  }

  return { filtered: false };
}

// ============================================================================
// Slack Bot Detection
// ============================================================================

/**
 * Check if a Slack message is from a bot.
 * Bot user IDs start with "B" (app bots) or "USLACKBOT" (system bot).
 */
export function isSlackBot(senderId: string): boolean {
  // Bot user IDs start with "B" (e.g., B12345)
  if (senderId.startsWith("B")) {
    return true;
  }

  // Slackbot has a special user ID
  if (senderId === "USLACKBOT") {
    return true;
  }

  return false;
}

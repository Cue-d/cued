"""
Message filters to skip LLM analysis for obviously non-actionable messages.

These filters have HIGH PRECISION - we prefer to let borderline cases through
to the LLM rather than accidentally filter real conversations.
"""

import re
from enum import Enum

from pydantic import BaseModel


class SkipReason(str, Enum):
    """Reasons why a message was skipped from LLM analysis."""

    SHORT_CODE = "short_code_sender"
    OTP_CODE = "otp_verification_code"
    DELIVERY_NOTIFICATION = "delivery_tracking"
    ACCOUNT_SECURITY_SPAM = "account_security_phishing"
    MARKETING_UNSUBSCRIBE = "marketing_with_unsubscribe"
    CARRIER_NOTIFICATION = "carrier_notification"
    URGENCY_SPAM = "urgency_spam_unknown_sender"
    PROMOTIONAL = "promotional_unknown_sender"
    BANK_ALERT = "bank_transaction_alert"
    PHISHING = "phishing_attempt"


class FilterResult(BaseModel):
    """Result of applying message filters."""

    should_skip: bool
    reason: SkipReason | None = None
    confidence: float = 0.0  # 0.0 to 1.0


# =============================================================================
# REGEX PATTERNS
# =============================================================================

# Short code: 5-6 digit numbers used by automated SMS systems
# Examples that WILL trigger:
#   - Sender: "12345"
#   - Sender: "72345"
#   - Sender: "123456"
SHORT_CODE_PATTERN = re.compile(r"^\d{5,6}$")

# OTP/2FA: Digit sequences (4-8 digits) near verification keywords
# Examples that WILL trigger:
#   - "Your verification code is 123456"
#   - "G-123456 is your Google verification code"
#   - "OTP: 4521"
#   - "Your PIN is 5678"
#   - "Authentication code: 789012"
OTP_PATTERN = re.compile(
    r"(?:"
    r"\b\d{4,8}\b.{0,30}?(code|verify|verification|otp|authentication|pin|confirm)|"
    r"(code|verify|verification|otp|authentication|pin).{0,30}?\b\d{4,8}\b"
    r")",
    re.IGNORECASE,
)

# Delivery/shipping: Package tracking and delivery notifications
# Examples that WILL trigger (requires link or tracking number):
#   - "UPS: Your package is out for delivery. Track: https://ups.com/track"
#   - "FedEx: Package delivered. Tracking #1234567890123456"
#   - "Your Amazon shipment has shipped"
#   - "USPS: Estimated arrival tomorrow"
DELIVERY_PATTERN = re.compile(
    r"(tracking|shipped|delivered|delivery|package|parcel|"
    r"ups|fedex|usps|dhl|amazon|"
    r"out for delivery|estimated arrival|shipment)",
    re.IGNORECASE,
)

# Account security phishing: Fake security alerts trying to steal credentials
# Examples that WILL trigger (non-contacts only):
#   - "Your account has been locked. Click here to verify"
#   - "Unusual activity detected. Confirm your identity"
#   - "Account suspended. Update your information now"
#   - "Security alert: verify your login at..."
ACCOUNT_SECURITY_PATTERN = re.compile(
    r"(locked|suspended|compromised|unusual activity|unauthorized|"
    r"security alert|verify your).{0,50}(verify|confirm|click|link|update|login)",
    re.IGNORECASE,
)

# Unsubscribe/opt-out: Marketing messages with opt-out instructions
# Examples that WILL trigger:
#   - "Reply STOP to unsubscribe"
#   - "Text STOP to cancel"
#   - "Opt-out: reply END"
#   - "To stop receiving messages, text STOP"
UNSUBSCRIBE_PATTERN = re.compile(
    r"(reply\s*stop|text\s*stop|stop\s*to\s*(cancel|end|opt|unsubscribe)|"
    r"unsubscribe|opt.?out|to\s*stop\s*receiving)",
    re.IGNORECASE,
)

# Carrier names: Mobile carrier and ISP notifications
# Examples that WILL trigger (by sender name):
#   - Sender: "AT&T Wireless"
#   - Sender: "Verizon Msg"
#   - Sender: "T-Mobile"
#   - Sender: "Xfinity"
CARRIER_NAMES = frozenset(
    {
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
    }
)

# Urgency spam: Pressure tactics to get immediate action
# Examples that WILL trigger (non-contacts only):
#   - "Act now! Limited offer!"
#   - "Expires in 24 hours"
#   - "Reply immediately to claim your prize"
#   - "Last chance! Don't miss out"
#   - "URGENT: Final notice"
URGENCY_PATTERN = re.compile(
    r"(act now|expires? in|limited time|24 hours?|48 hours?|"
    r"immediately|urgent|last chance|final notice|don'?t miss)",
    re.IGNORECASE,
)

# Promotional: Sales, discounts, and marketing offers
# Examples that WILL trigger (non-contacts only):
#   - "50% off everything today!"
#   - "Flash sale starts now!"
#   - "Use promo code SAVE20"
#   - "Free shipping on orders over $50"
#   - "BOGO deal this weekend"
PROMOTIONAL_PATTERN = re.compile(
    r"(\d+%\s*off|flash sale|deal|discount|coupon|promo\s*code|"
    r"free shipping|clearance|buy one get|bogo|special offer)",
    re.IGNORECASE,
)

# Bank/transaction alerts: Automated banking notifications
# Examples that WILL trigger (non-contacts only):
#   - "Chase: Purchase of $47.83 at Amazon on card ending 1234"
#   - "Direct deposit of $2,500.00 received"
#   - "Transaction alert: $100.00 withdrawal"
BANK_ALERT_PATTERN = re.compile(
    r"(card ending|transaction.{0,20}\$\d|purchase of \$|"
    r"direct deposit|withdrawal.{0,20}\$|balance.{0,20}\$|"
    r"payment.{0,20}(received|processed|due))",
    re.IGNORECASE,
)

# Phishing: Credential harvesting attempts
# Examples that WILL trigger (non-contacts only):
#   - "Verify your account at..."
#   - "Confirm your password by clicking..."
#   - "Update your payment information"
PHISHING_PATTERN = re.compile(
    r"(verify|confirm|update).{0,30}(account|password|payment|card|information|identity)|"
    r"(click|tap|visit).{0,20}(link|here|below).{0,20}(verify|confirm|update|secure)",
    re.IGNORECASE,
)


def is_short_code(identifier: str | None) -> FilterResult:
    """Filter short code senders (5-6 digit numbers).

    Short codes are always automated messaging systems (banks, airlines, etc).

    Examples that trigger:
        - Sender: "12345"
        - Sender: "72345"
        - Sender: "123456"
    """
    if identifier and SHORT_CODE_PATTERN.match(identifier.strip()):
        return FilterResult(should_skip=True, reason=SkipReason.SHORT_CODE, confidence=0.99)
    return FilterResult(should_skip=False)


def is_otp_message(text: str | None) -> FilterResult:
    """Filter 2FA/OTP verification codes.

    These are automated security codes that don't need a response.

    Examples that trigger:
        - "Your verification code is 123456"
        - "G-123456 is your Google verification code"
        - "OTP: 4521"
        - "Your PIN is 5678"
    """
    if text and OTP_PATTERN.search(text):
        return FilterResult(should_skip=True, reason=SkipReason.OTP_CODE, confidence=0.95)
    return FilterResult(should_skip=False)


def is_delivery_notification(text: str | None) -> FilterResult:
    """Filter delivery/shipping notifications.

    Only filters if the message contains delivery keywords AND a link or tracking number.

    Examples that trigger:
        - "UPS: Your package is out for delivery. Track: https://ups.com/track"
        - "FedEx: Package delivered. Tracking #1234567890123456"

    Examples that do NOT trigger (no link/tracking):
        - "Did you get the package I sent?"
    """
    if not text:
        return FilterResult(should_skip=False)

    if DELIVERY_PATTERN.search(text):
        # Extra check: should have a link or tracking number pattern
        has_link = "http" in text.lower() or "www." in text.lower()
        # Tracking numbers are typically 10-30 alphanumeric characters
        has_tracking = re.search(r"\b[A-Z0-9]{10,30}\b", text)
        if has_link or has_tracking:
            return FilterResult(
                should_skip=True, reason=SkipReason.DELIVERY_NOTIFICATION, confidence=0.90
            )
    return FilterResult(should_skip=False)


def is_account_security_spam(text: str | None, is_contact: bool) -> FilterResult:
    """Filter phishing attempts about account security.

    Only applies to non-contacts to avoid filtering messages from known people.

    Examples that trigger (non-contacts only):
        - "Your account has been locked. Click here to verify"
        - "Unusual activity detected. Confirm your identity"
        - "Account suspended. Update your information now"
    """
    if is_contact:
        return FilterResult(should_skip=False)  # Don't filter contacts
    if text and ACCOUNT_SECURITY_PATTERN.search(text):
        return FilterResult(
            should_skip=True, reason=SkipReason.ACCOUNT_SECURITY_SPAM, confidence=0.95
        )
    return FilterResult(should_skip=False)


def has_unsubscribe(text: str | None) -> FilterResult:
    """Filter marketing messages with unsubscribe text.

    Messages with unsubscribe/opt-out instructions are always automated marketing.

    Examples that trigger:
        - "Reply STOP to unsubscribe"
        - "Text STOP to cancel"
        - "Opt-out: reply END"
    """
    if text and UNSUBSCRIBE_PATTERN.search(text):
        return FilterResult(
            should_skip=True, reason=SkipReason.MARKETING_UNSUBSCRIBE, confidence=0.98
        )
    return FilterResult(should_skip=False)


def is_carrier_notification(person_name: str | None) -> FilterResult:
    """Filter carrier/service provider notifications.

    Matches sender name against known carrier names.

    Examples that trigger (by sender name):
        - Sender: "AT&T Wireless"
        - Sender: "Verizon Msg"
        - Sender: "T-Mobile"
    """
    if person_name:
        name_lower = person_name.lower()
        for carrier in CARRIER_NAMES:
            if carrier in name_lower:
                return FilterResult(
                    should_skip=True, reason=SkipReason.CARRIER_NOTIFICATION, confidence=0.95
                )
    return FilterResult(should_skip=False)


def is_urgency_spam(text: str | None, is_contact: bool) -> FilterResult:
    """Filter urgency-based spam (only for non-contacts).

    Messages with urgency language from unknown senders are typically spam.

    Examples that trigger (non-contacts only):
        - "Act now! Limited offer!"
        - "Expires in 24 hours"
        - "Reply immediately to claim your prize"
    """
    if is_contact:
        return FilterResult(should_skip=False)
    if text and URGENCY_PATTERN.search(text):
        return FilterResult(should_skip=True, reason=SkipReason.URGENCY_SPAM, confidence=0.80)
    return FilterResult(should_skip=False)


def is_promotional(text: str | None, is_contact: bool) -> FilterResult:
    """Filter promotional messages (only for non-contacts).

    Discount/sale language from unknown senders is typically marketing spam.

    Examples that trigger (non-contacts only):
        - "50% off everything today!"
        - "Flash sale starts now!"
        - "Use promo code SAVE20"
        - "Free shipping on orders over $50"
    """
    if is_contact:
        return FilterResult(should_skip=False)
    if text and PROMOTIONAL_PATTERN.search(text):
        return FilterResult(should_skip=True, reason=SkipReason.PROMOTIONAL, confidence=0.75)
    return FilterResult(should_skip=False)


def is_bank_alert(text: str | None, is_contact: bool) -> FilterResult:
    """Filter automated banking notifications (only for non-contacts).

    Transaction alerts from banks don't require responses.

    Examples that trigger (non-contacts only):
        - "Chase: Purchase of $47.83 at Amazon on card ending 1234"
        - "Direct deposit of $2,500.00 received"
        - "Transaction alert: $100.00 withdrawal"
    """
    if is_contact:
        return FilterResult(should_skip=False)
    if text and BANK_ALERT_PATTERN.search(text):
        return FilterResult(should_skip=True, reason=SkipReason.BANK_ALERT, confidence=0.90)
    return FilterResult(should_skip=False)


def is_phishing(text: str | None, is_contact: bool) -> FilterResult:
    """Filter phishing attempts (only for non-contacts).

    Messages trying to harvest credentials or personal information.

    Examples that trigger (non-contacts only):
        - "Verify your account at..."
        - "Confirm your password by clicking..."
        - "Update your payment information"
    """
    if is_contact:
        return FilterResult(should_skip=False)
    if text and PHISHING_PATTERN.search(text):
        return FilterResult(should_skip=True, reason=SkipReason.PHISHING, confidence=0.90)
    return FilterResult(should_skip=False)


def should_skip_llm_analysis(
    identifier: str | None,
    text: str | None,
    person_name: str | None,
    is_contact: bool,
) -> FilterResult:
    """
    Main entry point: determine if a chat should skip LLM analysis.

    Filters are ordered by confidence (highest first) and short-circuit on match.
    This ensures we catch the most obvious spam first while minimizing false positives.

    IMPORTANT: Contacts are trusted and bypass most content filters. Only universal
    spam signals (short codes, unsubscribe) are applied to contacts.

    Args:
        identifier: The sender's phone number or email
        text: The message text to analyze
        person_name: The display name of the sender
        is_contact: Whether the sender is a saved contact

    Returns:
        FilterResult with should_skip=True if the message should be filtered,
        along with the reason and confidence level.
    """
    # Tier 1: Sender-based (very high confidence, applies to all)
    result = is_short_code(identifier)
    if result.should_skip:
        return result

    # Tier 2: Universal content filters (applies to all senders)
    result = is_otp_message(text)
    if result.should_skip:
        return result

    result = has_unsubscribe(text)
    if result.should_skip:
        return result

    result = is_carrier_notification(person_name)
    if result.should_skip:
        return result

    result = is_delivery_notification(text)
    if result.should_skip:
        return result

    # Tier 3: Non-contact only filters (high confidence)
    # These patterns are too aggressive for contacts who might legitimately
    # send similar-looking messages
    result = is_account_security_spam(text, is_contact)
    if result.should_skip:
        return result

    result = is_bank_alert(text, is_contact)
    if result.should_skip:
        return result

    result = is_phishing(text, is_contact)
    if result.should_skip:
        return result

    # Tier 4: Lower confidence (only for non-contacts)
    result = is_urgency_spam(text, is_contact)
    if result.should_skip:
        return result

    result = is_promotional(text, is_contact)
    if result.should_skip:
        return result

    return FilterResult(should_skip=False)

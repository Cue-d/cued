"""Tests for message filtering heuristics."""

from services.message_filter import (
    SkipReason,
    has_unsubscribe,
    is_account_security_spam,
    is_carrier_notification,
    is_delivery_notification,
    is_otp_message,
    is_promotional,
    is_short_code,
    is_urgency_spam,
    should_skip_llm_analysis,
)


class TestShortCodeFilter:
    """Tests for short code sender detection."""

    def test_filters_5_digit_short_code(self):
        result = is_short_code("12345")
        assert result.should_skip is True
        assert result.reason == SkipReason.SHORT_CODE
        assert result.confidence >= 0.95

    def test_filters_6_digit_short_code(self):
        result = is_short_code("123456")
        assert result.should_skip is True

    def test_passes_phone_numbers(self):
        result = is_short_code("+12025551234")
        assert result.should_skip is False

    def test_passes_10_digit_phone(self):
        result = is_short_code("2025551234")
        assert result.should_skip is False

    def test_passes_email(self):
        result = is_short_code("john@example.com")
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_short_code(None)
        assert result.should_skip is False

    def test_passes_empty_string(self):
        result = is_short_code("")
        assert result.should_skip is False

    def test_filters_with_whitespace(self):
        result = is_short_code(" 12345 ")
        assert result.should_skip is True


class TestOTPFilter:
    """Tests for 2FA/OTP code detection."""

    def test_filters_verification_code(self):
        result = is_otp_message("Your verification code is 123456")
        assert result.should_skip is True
        assert result.reason == SkipReason.OTP_CODE

    def test_filters_otp(self):
        result = is_otp_message("OTP: 4521")
        assert result.should_skip is True

    def test_filters_auth_code(self):
        result = is_otp_message("Your authentication code: 789012")
        assert result.should_skip is True

    def test_filters_pin_code(self):
        result = is_otp_message("Your PIN is 5678")
        assert result.should_skip is True

    def test_filters_google_code(self):
        result = is_otp_message("G-123456 is your Google verification code")
        assert result.should_skip is True

    def test_filters_code_at_end(self):
        result = is_otp_message("Confirm your login with code 987654")
        assert result.should_skip is True

    def test_passes_normal_numbers_in_address(self):
        result = is_otp_message("I'll meet you at 1234 Main St")
        assert result.should_skip is False

    def test_passes_real_conversation(self):
        result = is_otp_message("Hey can you call me at 5pm?")
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_otp_message(None)
        assert result.should_skip is False

    def test_passes_number_without_keywords(self):
        result = is_otp_message("The total is 123456 dollars")
        assert result.should_skip is False


class TestDeliveryFilter:
    """Tests for delivery notification detection."""

    def test_filters_ups_tracking_with_link(self):
        result = is_delivery_notification(
            "UPS: Your package is out for delivery. Track: https://ups.com/track/1Z999"
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.DELIVERY_NOTIFICATION

    def test_filters_fedex_with_tracking_number(self):
        result = is_delivery_notification(
            "FedEx: Package delivered to front door. Tracking #1234567890123456"
        )
        assert result.should_skip is True

    def test_filters_amazon_delivery(self):
        result = is_delivery_notification(
            "Amazon: Your package will arrive today. Track at www.amazon.com/track"
        )
        assert result.should_skip is True

    def test_filters_usps_notification(self):
        result = is_delivery_notification(
            "USPS: Your shipment is out for delivery. Tracking: 9400111899223033005678"
        )
        assert result.should_skip is True

    def test_passes_casual_mention_no_link(self):
        # No link or tracking number
        result = is_delivery_notification("Did you get the package I sent?")
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_delivery_notification(None)
        assert result.should_skip is False


class TestAccountSecurityFilter:
    """Tests for phishing/account security spam detection."""

    def test_filters_locked_account_phishing(self):
        result = is_account_security_spam(
            "Your account has been locked. Click here to verify: http://evil.com",
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.ACCOUNT_SECURITY_SPAM

    def test_filters_suspended_account(self):
        result = is_account_security_spam(
            "Your account has been suspended. Confirm your identity to restore access.",
            is_contact=False,
        )
        assert result.should_skip is True

    def test_filters_unusual_activity(self):
        result = is_account_security_spam(
            "We detected unusual activity on your account. Please verify your information.",
            is_contact=False,
        )
        assert result.should_skip is True

    def test_passes_for_contacts(self):
        # Don't filter messages from saved contacts
        result = is_account_security_spam(
            "Your account has been locked",
            is_contact=True,
        )
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_account_security_spam(None, is_contact=False)
        assert result.should_skip is False


class TestUnsubscribeFilter:
    """Tests for marketing message detection via unsubscribe text."""

    def test_filters_reply_stop(self):
        result = has_unsubscribe("Great deals! Reply STOP to unsubscribe")
        assert result.should_skip is True
        assert result.reason == SkipReason.MARKETING_UNSUBSCRIBE

    def test_filters_text_stop(self):
        result = has_unsubscribe("50% off today only! Text STOP to cancel")
        assert result.should_skip is True

    def test_filters_opt_out(self):
        result = has_unsubscribe("Limited time offer! Opt-out: reply END")
        assert result.should_skip is True

    def test_filters_unsubscribe(self):
        result = has_unsubscribe("Weekly newsletter. Unsubscribe at example.com")
        assert result.should_skip is True

    def test_passes_normal_stop(self):
        # "stop" without unsubscribe context
        result = has_unsubscribe("Can you stop by the store?")
        assert result.should_skip is False

    def test_passes_none(self):
        result = has_unsubscribe(None)
        assert result.should_skip is False


class TestCarrierFilter:
    """Tests for carrier notification detection."""

    def test_filters_att(self):
        result = is_carrier_notification("AT&T Wireless")
        assert result.should_skip is True
        assert result.reason == SkipReason.CARRIER_NOTIFICATION

    def test_filters_verizon(self):
        result = is_carrier_notification("Verizon Msg")
        assert result.should_skip is True

    def test_filters_tmobile(self):
        result = is_carrier_notification("T-Mobile")
        assert result.should_skip is True

    def test_filters_tmobile_no_hyphen(self):
        result = is_carrier_notification("TMobile Alerts")
        assert result.should_skip is True

    def test_passes_normal_contact(self):
        result = is_carrier_notification("John Doe")
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_carrier_notification(None)
        assert result.should_skip is False


class TestUrgencySpamFilter:
    """Tests for urgency-based spam detection."""

    def test_filters_act_now(self):
        result = is_urgency_spam("Act now! Limited offer!", is_contact=False)
        assert result.should_skip is True
        assert result.reason == SkipReason.URGENCY_SPAM

    def test_filters_24_hours(self):
        result = is_urgency_spam("Offer expires in 24 hours!", is_contact=False)
        assert result.should_skip is True

    def test_filters_immediately(self):
        result = is_urgency_spam("Reply immediately to claim your prize", is_contact=False)
        assert result.should_skip is True

    def test_passes_for_contacts(self):
        # Real contacts can use urgency language
        result = is_urgency_spam("Can you call me immediately?", is_contact=True)
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_urgency_spam(None, is_contact=False)
        assert result.should_skip is False


class TestPromotionalFilter:
    """Tests for promotional content detection."""

    def test_filters_percentage_off(self):
        result = is_promotional("50% off everything today!", is_contact=False)
        assert result.should_skip is True
        assert result.reason == SkipReason.PROMOTIONAL

    def test_filters_flash_sale(self):
        result = is_promotional("Flash sale starts now!", is_contact=False)
        assert result.should_skip is True

    def test_filters_promo_code(self):
        result = is_promotional("Use promo code SAVE20", is_contact=False)
        assert result.should_skip is True

    def test_filters_free_shipping(self):
        result = is_promotional("Free shipping on orders over $50", is_contact=False)
        assert result.should_skip is True

    def test_passes_for_contacts(self):
        # Real contacts can mention sales
        result = is_promotional("Did you see the sale at Target?", is_contact=True)
        assert result.should_skip is False

    def test_passes_none(self):
        result = is_promotional(None, is_contact=False)
        assert result.should_skip is False


class TestIntegration:
    """Integration tests for the main should_skip_llm_analysis function."""

    def test_real_conversation_passes(self):
        """Real conversations from saved contacts should never be filtered."""
        result = should_skip_llm_analysis(
            identifier="+12025551234",
            text="Hey, are you free for coffee tomorrow?",
            person_name="John Doe",
            is_contact=True,
        )
        assert result.should_skip is False

    def test_spam_from_short_code_filtered(self):
        """Spam from short codes should be filtered."""
        result = should_skip_llm_analysis(
            identifier="72345",
            text="Flash sale! 50% off everything!",
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.SHORT_CODE  # First match wins

    def test_2fa_filtered(self):
        """2FA codes should be filtered."""
        result = should_skip_llm_analysis(
            identifier="+18005551234",
            text="Your Google verification code is 123456",
            person_name="Google",
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.OTP_CODE

    def test_delivery_notification_filtered(self):
        """Delivery notifications should be filtered."""
        result = should_skip_llm_analysis(
            identifier="+18005551234",
            text="Your package has been delivered. Track at http://ups.com/track",
            person_name="UPS",
            is_contact=False,
        )
        assert result.should_skip is True

    def test_carrier_notification_filtered(self):
        """Carrier notifications should be filtered."""
        result = should_skip_llm_analysis(
            identifier="+18005551234",
            text="You've used 90% of your data this month.",
            person_name="AT&T Wireless",
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.CARRIER_NOTIFICATION

    def test_marketing_with_unsubscribe_filtered(self):
        """Marketing messages with unsubscribe text should be filtered."""
        result = should_skip_llm_analysis(
            identifier="+18005551234",
            text="Big sale today! Reply STOP to opt out.",
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.MARKETING_UNSUBSCRIBE

    def test_unknown_number_with_link_but_personal(self):
        """Unknown numbers with personal-sounding messages should pass."""
        result = should_skip_llm_analysis(
            identifier="+12025559999",
            text="Hey, it's Sarah from the conference. Want to grab lunch?",
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is False

    def test_question_from_contact_passes(self):
        """Questions from contacts should never be filtered."""
        result = should_skip_llm_analysis(
            identifier="+12025551234",
            text="Did you get my email about the project deadline?",
            person_name="Jane Smith",
            is_contact=True,
        )
        assert result.should_skip is False

    def test_filter_priority_short_code_over_content(self):
        """Short code should be checked before content filters."""
        result = should_skip_llm_analysis(
            identifier="54321",
            text="Hey, are you free for coffee?",  # Looks like real conversation
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is True
        assert result.reason == SkipReason.SHORT_CODE

    def test_all_none_values_passes(self):
        """Edge case: all None values should pass (no crash)."""
        result = should_skip_llm_analysis(
            identifier=None,
            text=None,
            person_name=None,
            is_contact=False,
        )
        assert result.should_skip is False

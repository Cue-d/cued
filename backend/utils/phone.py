"""Phone number normalization utilities."""


def normalize_phone(phone: str) -> str:
    """Normalize phone number to digits only with + prefix for international.

    Examples:
        "+1 (555) 123-4567" -> "+15551234567"
        "555-123-4567" -> "5551234567"
        "+44 20 7946 0958" -> "+442079460958"
    """
    has_plus = phone.startswith("+")
    digits = "".join(c for c in phone if c.isdigit())
    if has_plus:
        return f"+{digits}"
    return digits


def get_phone_variants(phone: str) -> list[str]:
    """Get all possible normalized variants of a phone number for matching.

    US numbers can appear in chat.db as +1XXXXXXXXXX but in contacts as just
    XXXXXXXXXX or vice versa. This returns all variants to try.

    Examples:
        "+15551234567" -> ["+15551234567", "5551234567"]
        "5551234567" -> ["5551234567", "+15551234567"]
        "+442079460958" -> ["+442079460958"]  # Non-US, no variants
    """
    normalized = normalize_phone(phone)
    variants = [normalized]

    # If starts with +1 (US/Canada), also try without the +1
    if normalized.startswith("+1") and len(normalized) == 12:
        variants.append(normalized[2:])  # Remove +1

    # If it's a 10-digit number, also try with +1 (US/Canada format)
    if len(normalized) == 10 and normalized.isdigit():
        variants.append(f"+1{normalized}")

    return variants

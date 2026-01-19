/**
 * Phone number normalization utilities.
 * Ported from backend/utils/phone.py
 */

/**
 * Normalize phone number to digits only with + prefix for international.
 *
 * @example
 * normalizePhone("+1 (555) 123-4567") // "+15551234567"
 * normalizePhone("555-123-4567")      // "5551234567"
 * normalizePhone("+44 20 7946 0958")  // "+442079460958"
 */
export function normalizePhone(phone: string): string {
  const hasPlus = phone.startsWith("+");
  const digits = phone.replace(/\D/g, ""); // Remove all non-digit characters
  if (hasPlus) {
    return `+${digits}`;
  }
  return digits;
}

/**
 * Get all possible normalized variants of a phone number for matching.
 *
 * US numbers can appear in chat.db as +1XXXXXXXXXX but in contacts as just
 * XXXXXXXXXX or vice versa. This returns all variants to try.
 *
 * @example
 * getPhoneVariants("+15551234567")  // ["+15551234567", "5551234567"]
 * getPhoneVariants("5551234567")    // ["5551234567", "+15551234567"]
 * getPhoneVariants("15551234567")   // ["15551234567", "+15551234567", "5551234567"]
 * getPhoneVariants("+442079460958") // ["+442079460958"] // Non-US, no variants
 */
export function getPhoneVariants(phone: string): string[] {
  const normalized = normalizePhone(phone);
  const variants = [normalized];

  // If starts with +1 (US/Canada), also try without the +1
  if (normalized.startsWith("+1") && normalized.length === 12) {
    variants.push(normalized.slice(2)); // Remove +1
  }

  // If it's a 10-digit number, also try with +1 (US/Canada format)
  if (normalized.length === 10) {
    variants.push(`+1${normalized}`);
  }

  // If it's an 11-digit number starting with 1 (US/Canada without +), add variants
  // e.g., "15551234567" should match "+15551234567" and "5551234567"
  if (normalized.length === 11 && normalized.startsWith("1")) {
    variants.push(`+${normalized}`); // Add + prefix: "15551234567" -> "+15551234567"
    variants.push(normalized.slice(1)); // Remove leading 1: "15551234567" -> "5551234567"
  }

  return variants;
}

/**
 * Check if two phone numbers match (are the same person).
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const variants1 = getPhoneVariants(phone1);
  const variants2Set = new Set(getPhoneVariants(phone2));
  return variants1.some((v) => variants2Set.has(v));
}

/**
 * Format phone number for display.
 *
 * US numbers are formatted as (XXX) XXX-XXXX or +1 (XXX) XXX-XXXX.
 * International numbers with + prefix are returned with spacing.
 * Other numbers are returned as-is.
 *
 * @example
 * formatPhoneNumber("+15551234567")    // "+1 (555) 123-4567"
 * formatPhoneNumber("5551234567")      // "(555) 123-4567"
 * formatPhoneNumber("+442079460958")   // "+44 20 7946 0958"
 * formatPhoneNumber("123456")          // "123456"
 */
export function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  // Handle US numbers with country code (11 digits starting with 1)
  if (digits.length === 11 && digits.startsWith("1")) {
    const country = digits.slice(0, 1);
    const area = digits.slice(1, 4);
    const first = digits.slice(4, 7);
    const last = digits.slice(7, 11);
    return `+${country} (${area}) ${first}-${last}`;
  }

  // Handle US numbers without country code (10 digits)
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const first = digits.slice(3, 6);
    const last = digits.slice(6, 10);
    return `(${area}) ${first}-${last}`;
  }

  // Handle international numbers with + prefix (non-US)
  // Return original to preserve + and any existing formatting
  if (phone.startsWith("+")) {
    return phone;
  }

  // Return original for non-standard formats
  return phone;
}

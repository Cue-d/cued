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

  return variants;
}

/**
 * Deterministic contact matching utilities.
 * Task 6.0a: Match contacts by exact email/phone with normalization.
 */

import { normalizePhone, getPhoneVariants } from "@cued/shared";

/**
 * Normalize email address for matching.
 *
 * - Lowercase
 * - Trim whitespace
 * - Handle Gmail dot-variant normalization (j.doe@gmail.com = jdoe@gmail.com)
 * - Handle Gmail plus-addressing (user+tag@gmail.com = user@gmail.com)
 *
 * @example
 * normalizeEmail("John.Doe@Gmail.com")      // "johndoe@gmail.com"
 * normalizeEmail("user+work@gmail.com")     // "user@gmail.com"
 * normalizeEmail("  ADMIN@Company.Com  ")   // "admin@company.com"
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const [localPart, domain] = trimmed.split("@");

  if (!localPart || !domain) {
    return trimmed;
  }

  // Remove plus-addressing (everything after +) for all domains
  const plusIndex = localPart.indexOf("+");
  const withoutPlus = plusIndex !== -1 ? localPart.slice(0, plusIndex) : localPart;

  // Gmail and Google Workspace domains also ignore dots
  const gmailDomains = ["gmail.com", "googlemail.com"];
  if (gmailDomains.includes(domain)) {
    return `${withoutPlus.replace(/\./g, "")}@${domain}`;
  }

  return `${withoutPlus}@${domain}`;
}

/**
 * Get all variants of an email for matching.
 * Currently just returns the normalized form, but could be extended.
 */
export function getEmailVariants(email: string): string[] {
  return [normalizeEmail(email)];
}

/**
 * Check if two emails match (are the same person).
 */
export function emailsMatch(email1: string, email2: string): boolean {
  return normalizeEmail(email1) === normalizeEmail(email2);
}

/**
 * Check if two phones match (are the same person).
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const variants1 = getPhoneVariants(phone1);
  const variants2Set = new Set(getPhoneVariants(phone2));

  return variants1.some((v) => variants2Set.has(v));
}

/**
 * Find matching handles between two contacts.
 * Returns the type and value of the first match found.
 */
export function findHandleMatch(
  contact1: { emails: string[]; phones: string[] },
  contact2: { emails: string[]; phones: string[] }
): { type: "email" | "phone"; value: string } | null {
  // Check email matches
  for (const email1 of contact1.emails) {
    for (const email2 of contact2.emails) {
      if (emailsMatch(email1, email2)) {
        return { type: "email", value: normalizeEmail(email1) };
      }
    }
  }

  // Check phone matches
  for (const phone1 of contact1.phones) {
    for (const phone2 of contact2.phones) {
      if (phonesMatch(phone1, phone2)) {
        return { type: "phone", value: normalizePhone(phone1) };
      }
    }
  }

  return null;
}

export { normalizePhone, getPhoneVariants };

/**
 * LinkedIn URN normalization utilities.
 *
 * LinkedIn uses multiple URN formats for the same entities, which can cause
 * duplicates if not normalized consistently. This module provides utilities
 * to extract IDs and normalize URNs to a canonical format.
 *
 * Conversation URN formats:
 * - urn:li:fs_conversation:{id}
 * - urn:li:fsd_conversation:{id}
 * - urn:li:messagingThread:{id}
 *
 * Member/Profile URN formats:
 * - urn:li:member:{id}
 * - urn:li:fs_miniProfile:{id}
 * - urn:li:fsd_profile:{id}
 * - urn:li:msg_messagingparticipant:{id} (or nested: urn:li:msg_messagingparticipant:urn:li:fsd_profile:{id})
 */

// Conversation URN patterns - order matters (most specific first)
const CONVERSATION_PATTERNS = [
  /^urn:li:fs_conversation:(.+)$/,
  /^urn:li:fsd_conversation:(.+)$/,
  /^urn:li:messagingThread:(.+)$/,
];

// Member URN patterns - order matters (most specific first)
const MEMBER_PATTERNS = [
  /^urn:li:member:(.+)$/,
  /^urn:li:fs_miniProfile:(.+)$/,
  /^urn:li:fsd_profile:(.+)$/,
];

/**
 * Extract the ID portion from any LinkedIn URN.
 * Handles various formats with different prefixes.
 *
 * @param urn - The full URN string (e.g., "urn:li:fsd_profile:ABC123")
 * @returns The ID portion (e.g., "ABC123"), or null if not a valid URN
 *
 * @example
 * extractIdFromURN("urn:li:fsd_profile:ABC123") // => "ABC123"
 * extractIdFromURN("urn:li:fs_conversation:12345") // => "12345"
 * extractIdFromURN("not-a-urn") // => null
 */
export function extractIdFromURN(urn: string): string | null {
  if (!urn || !urn.startsWith("urn:li:")) return null;
  // Match pattern: urn:li:{type}:{id}
  // The ID is everything after the last colon
  const match = urn.match(/^urn:li:[^:]+:(.+)$/);
  return match ? match[1] : null;
}

/**
 * Normalize a conversation URN to the canonical format: urn:li:fs_conversation:{id}
 *
 * @param urn - The conversation URN in any format
 * @returns Normalized URN in fs_conversation format, or original if not recognized
 *
 * @example
 * normalizeConversationURN("urn:li:fsd_conversation:123") // => "urn:li:fs_conversation:123"
 * normalizeConversationURN("urn:li:messagingThread:456") // => "urn:li:fs_conversation:456"
 * normalizeConversationURN("urn:li:fs_conversation:789") // => "urn:li:fs_conversation:789"
 */
export function normalizeConversationURN(urn: string): string {
  if (!urn) return urn;

  for (const pattern of CONVERSATION_PATTERNS) {
    const match = urn.match(pattern);
    if (match) {
      return `urn:li:fs_conversation:${match[1]}`;
    }
  }

  // Return as-is if no pattern matches (might already be normalized or invalid)
  return urn;
}

/**
 * Normalize a member/profile URN to the canonical format: urn:li:member:{id}
 *
 * @param urn - The member URN in any format
 * @returns Normalized URN in member format, or original if not recognized
 *
 * @example
 * normalizeMemberURN("urn:li:fsd_profile:ABC123") // => "urn:li:member:ABC123"
 * normalizeMemberURN("urn:li:fs_miniProfile:XYZ") // => "urn:li:member:XYZ"
 * normalizeMemberURN("urn:li:member:123") // => "urn:li:member:123"
 */
export function normalizeMemberURN(urn: string): string {
  if (!urn) return urn;

  // Handle nested msg_messagingparticipant URNs (e.g., urn:li:msg_messagingparticipant:urn:li:fsd_profile:ID)
  const msgParticipantMatch = urn.match(
    /^urn:li:msg_messagingparticipant:(.+)$/
  );
  if (msgParticipantMatch) {
    const inner = msgParticipantMatch[1];
    // If inner value is itself a URN, recursively normalize it
    if (inner.startsWith("urn:li:")) {
      return normalizeMemberURN(inner);
    }
    // Non-nested: treat inner value as the member ID directly
    return `urn:li:member:${inner}`;
  }

  for (const pattern of MEMBER_PATTERNS) {
    const match = urn.match(pattern);
    if (match) {
      return `urn:li:member:${match[1]}`;
    }
  }

  // Return as-is if no pattern matches
  return urn;
}

/**
 * Check if a string is a LinkedIn URN.
 *
 * @param value - The string to check
 * @returns True if the string is a LinkedIn URN
 */
export function isLinkedInURN(value: string): boolean {
  return value?.startsWith("urn:li:") ?? false;
}

/**
 * Check if a string is a LinkedIn conversation URN.
 *
 * @param value - The string to check
 * @returns True if the string is a conversation URN
 */
export function isConversationURN(value: string): boolean {
  return CONVERSATION_PATTERNS.some((p) => p.test(value));
}

/**
 * Check if a string is a LinkedIn member/profile URN.
 *
 * @param value - The string to check
 * @returns True if the string is a member URN
 */
export function isMemberURN(value: string): boolean {
  if (/^urn:li:msg_messagingparticipant:/.test(value)) return true;
  return MEMBER_PATTERNS.some((p) => p.test(value));
}

/**
 * Compare two LinkedIn URNs by their ID portion.
 * Handles the case where the same entity has different URN prefixes.
 *
 * @param urn1 - First URN to compare
 * @param urn2 - Second URN to compare
 * @returns True if both URNs have the same ID portion
 *
 * @example
 * urnIdsMatch("urn:li:fsd_profile:ABC", "urn:li:fs_miniProfile:ABC") // => true
 * urnIdsMatch("urn:li:member:123", "urn:li:member:456") // => false
 */
export function urnIdsMatch(
  urn1: string | undefined,
  urn2: string | undefined
): boolean {
  if (!urn1 || !urn2) return false;
  const id1 = extractIdFromURN(urn1);
  const id2 = extractIdFromURN(urn2);
  // Case-insensitive comparison since LinkedIn URN IDs may have inconsistent casing
  return (
    id1 !== null &&
    id2 !== null &&
    id1.toLowerCase() === id2.toLowerCase()
  );
}

/**
 * Extract the LinkedIn messaging thread ID from a conversation URN.
 * Handles nested URN formats with embedded profile URNs.
 *
 * @example
 * extractLinkedInThreadId("urn:li:fs_conversation:(urn:li:fsd_profile:XXX,2-abc==)") // => "2-abc=="
 * extractLinkedInThreadId("urn:li:fs_conversation:simple-id") // => "simple-id"
 * extractLinkedInThreadId("2-abc==") // => "2-abc=="
 */
export function extractLinkedInThreadId(platformConversationId: string): string {
  // Handle nested format: urn:li:{type}:(urn:li:fsd_profile:XXX,CONV_ID)
  const commaMatch = platformConversationId.match(/,([^)]+)\)$/);
  if (commaMatch) return commaMatch[1];

  // Handle simple URN: urn:li:{type}:ID
  return extractIdFromURN(platformConversationId) ?? platformConversationId;
}

// ============================================================================
// LinkedIn Handle Normalization
// ============================================================================

/**
 * Validate a LinkedIn handle format.
 * LinkedIn handles: alphanumeric + hyphens, 3-100 characters.
 */
export function isValidLinkedInHandle(handle: string): boolean {
  return /^[a-zA-Z0-9-]{3,100}$/.test(handle);
}

/**
 * Normalize LinkedIn handle to canonical format for consistent deduplication.
 * Extracts username from URL or returns cleaned handle.
 * Returns: lowercase username (e.g., "johndoe") or empty string if invalid.
 */
export function normalizeLinkedInHandle(input: string): string {
  if (!input) return "";
  const clean = input.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const match = clean.match(/linkedin\.com\/in\/([^/]+)/i);
  if (match) {
    const handle = match[1];
    if (isValidLinkedInHandle(handle)) {
      return handle.toLowerCase();
    }
    console.warn(`[LinkedIn] Invalid handle extracted from URL: ${handle}`);
    return "";
  }
  // Already a handle - validate and lowercase
  if (isValidLinkedInHandle(clean)) {
    return clean.toLowerCase();
  }
  return "";
}

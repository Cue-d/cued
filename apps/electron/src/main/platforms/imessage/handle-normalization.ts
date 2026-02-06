/**
 * macOS Messages can append "(filtered)" to unknown-sender handles in chat.db.
 * Strip this transport suffix so downstream sync uses stable identifiers.
 */
const FILTERED_SUFFIX_REGEX = /\s*\(filtered\)\s*$/i;

export function normalizeChatDbHandleIdentifier(identifier: string): string {
  return identifier.replace(FILTERED_SUFFIX_REGEX, "");
}


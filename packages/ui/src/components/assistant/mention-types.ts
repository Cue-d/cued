/**
 * Types and utilities for @mention functionality in assistant chat
 */

export interface MentionedContact {
  id: string
  displayName: string
  company?: string | null
}

export interface MentionSearchResult {
  _id: string
  displayName: string
  company?: string | null
  handles?: Array<{
    type: string
    value: string
    platform?: string
  }>
}

/**
 * Regex to match mentions in format: @[Display Name](contact:id)
 * Groups: 1 = display name, 2 = contact id
 * Used for backend parsing when contact IDs are embedded
 */
export const MENTION_REGEX = /@\[([^\]]+)\]\(contact:([^)]+)\)/g

/**
 * Regex to match display mentions in format: @Name or @Name (context)
 * Groups: 1 = full display (name + optional context)
 * Used for styling mentions in the UI
 * Requires mention to be followed by whitespace, punctuation, or end-of-string
 * First letter must be uppercase to distinguish from email-like @domain patterns
 */
export const MENTION_DISPLAY_REGEX =
  /@([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*(?:\s*\([^)]+\))?)(?=\s|$|[.,!?;:])/g

/**
 * Parse mentions from text and return contact IDs + clean text
 */
export function parseMentions(text: string): {
  contactIds: string[]
  cleanText: string
} {
  const contactIds: string[] = []
  let match: RegExpExecArray | null

  // Reset regex state
  MENTION_REGEX.lastIndex = 0

  while ((match = MENTION_REGEX.exec(text)) !== null) {
    contactIds.push(match[2])
  }

  // Replace mentions with just the display name for clean text
  const cleanText = text.replace(MENTION_REGEX, "@$1")

  return { contactIds, cleanText }
}

/**
 * Format a contact as a mention string for storage/parsing
 * This includes the full ID for backend parsing
 */
export function formatMention(contact: MentionedContact): string {
  return `@[${contact.displayName}](contact:${contact.id})`
}

/**
 * Format a contact mention for display in the textarea
 * Shows @Name or @Name (context) for disambiguation
 */
export function formatMentionDisplay(
  contact: MentionedContact,
  context?: string | null
): string {
  if (context) {
    return `@${contact.displayName} (${context})`
  }
  return `@${contact.displayName}`
}

/**
 * Extract mentions as structured data for context injection
 */
export function extractMentions(text: string): MentionedContact[] {
  const mentions: MentionedContact[] = []
  let match: RegExpExecArray | null

  // Reset regex state
  MENTION_REGEX.lastIndex = 0

  while ((match = MENTION_REGEX.exec(text)) !== null) {
    mentions.push({
      id: match[2],
      displayName: match[1],
    })
  }

  return mentions
}

/**
 * Find a completed mention at the start of text (anchored match).
 * Returns the full match string if found, null otherwise.
 * Uses non-global regex to avoid shared state issues with concurrent renders.
 */
export function matchMentionAtStart(text: string): string | null {
  const match = text.match(
    /^@([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*(?:\s*\([^)]+\))?)(?=\s|$|[.,!?;:])/
  )
  return match ? match[0] : null
}

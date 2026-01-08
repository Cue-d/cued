// Reaction parsing logic for iMessage tapbacks
// Note: iMessage uses curly quotes U+201C (") and U+201D (") not straight quotes
const LQ = '\u201C' // " LEFT DOUBLE QUOTATION MARK
const RQ = '\u201D' // " RIGHT DOUBLE QUOTATION MARK

// Helper to create pattern with curly quotes
const q = (prefix: string, suffix = '') => new RegExp(`^${prefix} ${LQ}(.+)${RQ}${suffix}$`, 's')

// Helper for custom emoji reactions (emoji in group 1, text in group 2)
const qEmoji = (prefix: string, mid: string) =>
  new RegExp(`^${prefix} (.+?) ${mid} ${LQ}(.+)${RQ}$`, 's')

const REACTION_PATTERNS: { pattern: RegExp; emoji: string | null }[] = [
  // English
  { pattern: q('Loved'), emoji: '❤️' },
  { pattern: q('Liked'), emoji: '👍' },
  { pattern: q('Disliked'), emoji: '👎' },
  { pattern: q('Laughed at'), emoji: '😂' },
  { pattern: q('Emphasized'), emoji: '‼️' },
  { pattern: q('Questioned'), emoji: '❓' },
  // British English
  { pattern: q('Emphasised'), emoji: '‼️' },
  // Spanish
  { pattern: q('Le gusta'), emoji: '👍' },
  { pattern: q('Le encanta'), emoji: '❤️' },
  { pattern: q('Le encantó'), emoji: '❤️' },
  { pattern: q('Le hace gracia'), emoji: '😂' },
  { pattern: q('Exclamó por'), emoji: '‼️' },
  // Italian
  { pattern: q('Ha aggiunto un cuoricino a'), emoji: '❤️' },
  // German (different quote style: „text")
  { pattern: /^„(.+)" ein Herz hinzugefügt$/s, emoji: '❤️' },
  // Custom emoji reactions
  { pattern: qEmoji('Reacted', 'to'), emoji: null },
  { pattern: qEmoji('Se ha reaccionado con', 'a'), emoji: null },
  { pattern: qEmoji('Ha reagito con', 'a'), emoji: null }
]

export interface MessageItem {
  id: number
  text: string | null
  isSent: boolean
  timestamp: number
  senderName?: string | null
  // Delivery status fields
  isRead?: boolean
  dateRead?: number | null
  isDelivered?: boolean
  dateDelivered?: number | null
  error?: number
}

export interface ParsedReaction {
  emoji: string
  targetText: string
  messageId: number
}

export function parseReaction(message: MessageItem): ParsedReaction | null {
  if (!message.text) return null

  for (const { pattern, emoji } of REACTION_PATTERNS) {
    const match = message.text.match(pattern)
    if (match) {
      if (emoji === null) {
        return { emoji: match[1], targetText: match[2], messageId: message.id }
      }
      return { emoji, targetText: match[1], messageId: message.id }
    }
  }
  return null
}

export function processMessagesWithReactions(messages: MessageItem[]): {
  displayMessages: MessageItem[]
  reactionsByMessageId: Map<number, string[]>
} {
  const reactions: ParsedReaction[] = []
  const displayMessages: MessageItem[] = []
  const reactionsByMessageId = new Map<number, string[]>()

  for (const msg of messages) {
    const reaction = parseReaction(msg)
    if (reaction) {
      reactions.push(reaction)
    } else {
      displayMessages.push(msg)
    }
  }

  for (const reaction of reactions) {
    const normalizedTargetText = reaction.targetText.trim()
    const targetMessage = displayMessages.find((msg) => msg.text?.trim() === normalizedTargetText)

    if (targetMessage) {
      const existing = reactionsByMessageId.get(targetMessage.id) || []
      if (!existing.includes(reaction.emoji)) {
        existing.push(reaction.emoji)
        reactionsByMessageId.set(targetMessage.id, existing)
      }
    }
  }

  return { displayMessages, reactionsByMessageId }
}

import { useEffect, useCallback } from 'react'
import { fetchMessages, sendMessage, type MessageResponse } from '@/api/client'
import type { Attachment, Chat, DeliveryStatus, Message, ReactionType } from '@/data/types'

// Regex to detect reaction messages (e.g., "Loved "some text"" or "Liked "some text"")
const REACTION_REGEX = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)\s+"(.*)"/

// Map reaction text to type
const REACTION_TEXT_MAP: Record<string, ReactionType> = {
  Loved: 'love',
  Liked: 'like',
  Disliked: 'dislike',
  'Laughed at': 'laugh',
  Emphasized: 'emphasize',
  Questioned: 'question'
}

// Parse reaction from message text (returns null if not a reaction)
function parseReaction(text: string | null): { type: ReactionType; quotedText: string } | null {
  if (!text) return null
  const match = text.match(REACTION_REGEX)
  if (!match) return null
  const [, reactionWord, quotedText] = match
  const type = REACTION_TEXT_MAP[reactionWord]
  if (!type) return null
  return { type, quotedText }
}

function toAttachment(a: {
  id: number
  filename: string | null
  mime_type: string | null
  size: number | null
  is_image: boolean
}): Attachment {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    size: a.size,
    isImage: a.is_image
  }
}

function computeDeliveryStatus(m: MessageResponse): DeliveryStatus {
  if (m.error !== 0) return 'failed'
  if (!m.is_from_me) return 'read' // Incoming messages don't show delivery status
  if (m.is_read) return 'read'
  if (m.is_delivered) return 'delivered'
  if (m.is_sent) return 'sent'
  return 'sending'
}

// Convert API message response to UI model
export const toMessage = (m: MessageResponse): Message => {
  const reactionInfo = parseReaction(m.text)

  return {
    id: String(m.id),
    text: m.text || '',
    isSent: m.is_from_me,
    isRead: m.is_read,
    timestamp: new Date(m.date * 1000),
    senderName: m.sender_name,
    deliveryStatus: computeDeliveryStatus(m),
    attachments: m.attachments?.map(toAttachment) || [],
    // Reaction info parsed from message text
    isReaction: reactionInfo !== null,
    reactionType: reactionInfo?.type,
    reactionQuotedText: reactionInfo?.quotedText
  }
}

interface UseMessagesOptions {
  selectedId: string | null
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  pollInterval?: number
}

interface UseMessagesReturn {
  handleSendMessage: (chatId: number, text: string) => Promise<void>
}

export function useMessages({
  selectedId,
  setChats,
  pollInterval = 500
}: UseMessagesOptions): UseMessagesReturn {
  // Load messages when selection changes
  useEffect(() => {
    if (!selectedId) return

    const loadMessages = () => {
      fetchMessages(Number(selectedId), 100)
        .then((data) => {
          const messages = data.map(toMessage).reverse() // API returns desc, we want asc
          setChats((prev) => prev.map((c) => (c.id === selectedId ? { ...c, messages } : c)))
        })
        .catch(console.error)
    }

    // Load immediately
    loadMessages()

    // Auto-refresh for near-instant message updates
    const interval = setInterval(loadMessages, pollInterval)

    return () => clearInterval(interval)
  }, [selectedId, setChats, pollInterval])

  const handleSendMessage = useCallback(
    async (chatId: number, text: string) => {
      const result = await sendMessage(chatId, text)
      if (!result.success) {
        throw new Error(result.error || 'Failed to send message')
      }
      // Refresh messages after sending
      const data = await fetchMessages(chatId, 100)
      const messages = data.map(toMessage).reverse()
      setChats((prev) => prev.map((c) => (c.id === String(chatId) ? { ...c, messages } : c)))
    },
    [setChats]
  )

  return {
    handleSendMessage
  }
}

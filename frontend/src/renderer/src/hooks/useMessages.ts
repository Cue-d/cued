import { useEffect, useCallback } from 'react'
import { fetchMessages, sendMessage, MessageResponse } from '@/api/client'
import { Chat, Message } from '@/data/types'

// Convert API message response to UI model
export const toMessage = (m: MessageResponse): Message => ({
  id: String(m.id),
  text: m.text || '',
  isSent: m.is_from_me,
  isRead: m.is_read,
  timestamp: new Date(m.date * 1000),
  senderName: m.sender_name
})

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

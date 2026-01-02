import { useState, useEffect, useCallback } from 'react'
import { fetchConversations, ConversationResponse } from '@/api/client'
import { Conversation, Message } from '@/data/types'

// Helper to get initials from a name
const getInitials = (name: string) =>
  name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

// Convert API response to UI model
export const toConversation = (
  c: ConversationResponse,
  messages: Message[] = []
): Conversation => ({
  id: String(c.id),
  name: c.name,
  initials: getInitials(c.name),
  isGroup: c.is_group || c.handle_ids.length > 1,
  groupAvatars: c.member_names.map(getInitials),
  lastMessage: c.last_message || '',
  timestamp: new Date(c.last_message_date * 1000),
  messages
})

interface UseConversationsReturn {
  conversations: Conversation[]
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>
  selectedId: string | null
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  handleLoadMore: () => void
}

export function useConversations(): UseConversationsReturn {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  // Load conversations on mount
  useEffect(() => {
    const initialLimit = 50
    fetchConversations(initialLimit, 0)
      .then((data) => {
        const convos = data.map((c) => toConversation(c))
        setConversations(convos)
        setHasMore(data.length === initialLimit)
        // Use functional update to avoid dependency on selectedId
        setSelectedId((prev) => (convos.length > 0 && !prev ? convos[0].id : prev))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Load more conversations
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return

    setLoadingMore(true)
    const offset = conversations.length
    const limit = 50

    try {
      const data = await fetchConversations(limit, offset)

      if (data.length === 0) {
        setHasMore(false)
        return
      }

      const newConvos = data.map((c) => toConversation(c))

      // Filter duplicates using current state
      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.id))
        const uniqueNewConvos = newConvos.filter((c) => !existingIds.has(c.id))
        return uniqueNewConvos.length > 0 ? [...prev, ...uniqueNewConvos] : prev
      })

      // Determine if there are more results - use newConvos length check
      // since we can't know uniqueNewConvos without accessing state
      setHasMore(data.length === limit)
    } catch (error) {
      console.error(error)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, conversations.length])

  return {
    conversations,
    setConversations,
    selectedId,
    setSelectedId,
    loading,
    loadingMore,
    hasMore,
    handleLoadMore
  }
}

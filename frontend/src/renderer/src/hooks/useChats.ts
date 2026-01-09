import { useState, useEffect, useCallback } from 'react'
import { fetchChats, ChatResponse } from '@/api/client'
import { Chat, Message } from '@/data/types'
import { getInitials } from '@/lib/utils'

// Convert API response to UI model
export const toChat = (c: ChatResponse, messages: Message[] = []): Chat => ({
  id: String(c.id),
  name: c.name,
  initials: getInitials(c.name),
  isGroup: c.is_group || c.handle_ids.length > 1,
  groupAvatars: c.member_names.map(getInitials),
  lastMessage: c.last_message || '',
  timestamp: new Date(c.last_message_date * 1000),
  messages
})

interface UseChatsReturn {
  chats: Chat[]
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  selectedId: string | null
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  handleLoadMore: () => void
}

export function useChats(): UseChatsReturn {
  const [chats, setChats] = useState<Chat[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  // Load chats on mount and poll for updates
  useEffect(() => {
    const initialLimit = 50

    const loadChats = (isInitial = false) => {
      fetchChats(initialLimit, 0)
        .then((data) => {
          const loadedChats = data.map((c) => toChat(c))
          // Preserve messages from existing chats
          setChats((prev) => {
            const prevMap = new Map(prev.map((c) => [c.id, c]))
            return loadedChats.map((c) => ({
              ...c,
              messages: prevMap.get(c.id)?.messages || []
            }))
          })
          setHasMore(data.length === initialLimit)
          if (isInitial) {
            setSelectedId((prev) => (loadedChats.length > 0 && !prev ? loadedChats[0].id : prev))
          }
        })
        .catch(console.error)
        .finally(() => {
          if (isInitial) setLoading(false)
        })
    }

    // Initial load
    loadChats(true)

    // Poll for updates every 1 second
    const interval = setInterval(() => loadChats(false), 1000)
    return () => clearInterval(interval)
  }, [])

  // Load more chats
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return

    setLoadingMore(true)
    const offset = chats.length
    const limit = 50

    try {
      const data = await fetchChats(limit, offset)

      if (data.length === 0) {
        setHasMore(false)
        return
      }

      const newChats = data.map((c) => toChat(c))

      // Filter duplicates using current state
      setChats((prev) => {
        const existingIds = new Set(prev.map((c) => c.id))
        const uniqueNewChats = newChats.filter((c) => !existingIds.has(c.id))
        return uniqueNewChats.length > 0 ? [...prev, ...uniqueNewChats] : prev
      })

      // Determine if there are more results - use newChats length check
      // since we can't know uniqueNewChats without accessing state
      setHasMore(data.length === limit)
    } catch (error) {
      console.error(error)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, chats.length])

  return {
    chats,
    setChats,
    selectedId,
    setSelectedId,
    loading,
    loadingMore,
    hasMore,
    handleLoadMore
  }
}

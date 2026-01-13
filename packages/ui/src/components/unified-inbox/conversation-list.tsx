"use client"

import { useCallback, useRef } from "react"
import { Search, SquarePen } from "lucide-react"
import { cn } from "../../lib/utils"
import { ConversationItem } from "./conversation-item"
import type { Conversation } from "./types"

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onLoadMore?: () => void
  hasMore?: boolean
  loading?: boolean
  className?: string
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  loading,
  className,
}: ConversationListProps): React.ReactElement {
  const loadingRef = useRef(false)

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!onLoadMore || !hasMore || loading || loadingRef.current) return

      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
      const scrollPercentage = (scrollTop + clientHeight) / scrollHeight

      if (scrollPercentage > 0.8) {
        loadingRef.current = true
        onLoadMore()
        setTimeout(() => {
          loadingRef.current = false
        }, 500)
      }
    },
    [onLoadMore, hasMore, loading]
  )

  return (
    <div className={cn("w-80 min-w-80 shrink-0 h-full bg-sidebar flex flex-col border-r", className)}>
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b">
        <h2 className="font-semibold text-foreground">Inbox</h2>
        <button
          type="button"
          className="p-1.5 hover:bg-muted rounded-lg transition-colors"
        >
          <SquarePen className="w-[18px] h-[18px] text-primary" />
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search conversations..."
            className="w-full h-[34px] pl-8 pr-3 rounded-md bg-muted text-foreground placeholder:text-muted-foreground text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div onScroll={handleScroll} className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            No conversations yet
          </div>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((conversation) => (
              <ConversationItem
                key={conversation._id}
                conversation={conversation}
                isSelected={selectedId === conversation._id}
                onClick={() => onSelect(conversation._id)}
              />
            ))}
            {loading && (
              <div className="flex items-center justify-center py-4">
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

import { Search, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Conversation, formatTimestamp } from '@/data/types'
import Avatar from './Avatar'
import { useRef, useEffect } from 'react'

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onLoadMore?: () => void
  hasMore?: boolean
  loading?: boolean
}

interface ConversationItemProps {
  conversation: Conversation
  isSelected: boolean
  onClick: () => void
}

const ConversationItem = ({ conversation, isSelected, onClick }: ConversationItemProps) => {
  // Check if conversation has any unread received messages
  const hasUnread = conversation.messages.some(m => !m.isSent && !m.isRead)

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left relative',
        isSelected ? 'bg-imessage-selected text-imessage-selected-foreground' : 'hover:bg-sidebar-accent'
      )}
    >
      {/* Blue dot for unread messages */}
      {hasUnread && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
      )}
      <Avatar
        initials={conversation.initials || conversation.name.charAt(0)}
        isGroup={conversation.isGroup}
        groupMembers={conversation.groupAvatars}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={cn('font-medium truncate text-[15px]', isSelected ? 'text-imessage-selected-foreground' : 'text-foreground')}>
            {conversation.name}
          </span>
          <span className={cn('text-xs flex-shrink-0', isSelected ? 'text-imessage-selected-foreground/70' : 'text-imessage-timestamp')}>
            {formatTimestamp(conversation.timestamp)}
          </span>
        </div>
        <p className={cn('text-[13px] truncate mt-0.5', isSelected ? 'text-imessage-selected-foreground/80' : 'text-muted-foreground')}>
          {conversation.lastMessage}
        </p>
      </div>
    </button>
  )
}

const ConversationList = ({ conversations, selectedId, onSelect, onLoadMore, hasMore, loading }: ConversationListProps) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !onLoadMore || !hasMore || loading) return

    const handleScroll = () => {
      if (loadingRef.current) return

      const { scrollTop, scrollHeight, clientHeight } = container
      const scrollPercentage = (scrollTop + clientHeight) / scrollHeight

      // Load more when scrolled 80% down
      if (scrollPercentage > 0.8) {
        loadingRef.current = true
        onLoadMore()
        // Reset after a delay to prevent rapid firing
        setTimeout(() => {
          loadingRef.current = false
        }, 500)
      }
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [onLoadMore, hasMore, loading])

  return (
    <div className="w-80 h-full bg-imessage-sidebar border-r border-imessage-sidebar-border flex flex-col">
      {/* Search + New Message */}
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search"
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-muted text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <button className="p-2 hover:bg-sidebar-accent rounded-lg transition-colors">
          <SquarePen className="w-5 h-5 text-primary" />
        </button>
      </div>

      {/* Conversation List */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        <div className="space-y-0.5">
          {conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isSelected={selectedId === conversation.id}
              onClick={() => onSelect(conversation.id)}
            />
          ))}
          {loading && (
            <div className="flex items-center justify-center py-4">
              <span className="text-sm text-muted-foreground">Loading more...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConversationList

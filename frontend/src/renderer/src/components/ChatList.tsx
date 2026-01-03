import { Search, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Chat, formatTimestamp } from '@/data/types'
import Avatar from './Avatar'
import { useRef, useEffect } from 'react'

interface ChatListProps {
  chats: Chat[]
  selectedId: string | null
  onSelect: (id: string) => void
  onLoadMore?: () => void
  hasMore?: boolean
  loading?: boolean
}

interface ChatItemProps {
  chat: Chat
  isSelected: boolean
  onClick: () => void
}

const ChatItem = ({ chat, isSelected, onClick }: ChatItemProps) => {
  // Check if chat has any unread received messages
  const hasUnread = chat.messages.some((m) => !m.isSent && !m.isRead)

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left relative',
        isSelected
          ? 'bg-imessage-selected text-imessage-selected-foreground'
          : 'hover:bg-sidebar-accent'
      )}
    >
      {/* Blue dot for unread messages */}
      {hasUnread && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
      )}
      <Avatar
        initials={chat.initials || chat.name.charAt(0)}
        isGroup={chat.isGroup}
        groupMembers={chat.groupAvatars}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'font-medium truncate text-[15px]',
              isSelected ? 'text-imessage-selected-foreground' : 'text-foreground'
            )}
          >
            {chat.name}
          </span>
          <span
            className={cn(
              'text-xs flex-shrink-0',
              isSelected ? 'text-imessage-selected-foreground/70' : 'text-imessage-timestamp'
            )}
          >
            {formatTimestamp(chat.timestamp)}
          </span>
        </div>
        <p
          className={cn(
            'text-[13px] truncate mt-0.5',
            isSelected ? 'text-imessage-selected-foreground/80' : 'text-muted-foreground'
          )}
        >
          {chat.lastMessage}
        </p>
      </div>
    </button>
  )
}

const ChatList = ({ chats, selectedId, onSelect, onLoadMore, hasMore, loading }: ChatListProps) => {
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
    <div className="w-80 min-w-80 flex-shrink-0 h-full bg-imessage-sidebar border-r border-imessage-sidebar-border flex flex-col">
      {/* Header with traffic light space and new message button */}
      <div className="h-11 flex items-center justify-end px-4 pt-1.5 -mt-1">
        <button className="p-1.5 hover:bg-sidebar-accent rounded-lg transition-colors">
          <SquarePen className="w-[18px] h-[18px] text-primary" />
        </button>
      </div>

      {/* Search bar */}
      <div className="px-4 pb-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search"
            className="w-full h-[34px] pl-8 pr-3 rounded-md bg-muted text-foreground placeholder:text-muted-foreground text-[13px] focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Chat List */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        <div className="space-y-0.5">
          {chats.map((chat) => (
            <ChatItem
              key={chat.id}
              chat={chat}
              isSelected={selectedId === chat.id}
              onClick={() => onSelect(chat.id)}
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

export default ChatList

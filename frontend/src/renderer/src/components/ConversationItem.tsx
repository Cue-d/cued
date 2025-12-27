import { cn } from '@/lib/utils'
import { Conversation, formatTimestamp } from '@/data/mockData'
import Avatar from './Avatar'

interface ConversationItemProps {
  conversation: Conversation
  isSelected: boolean
  onClick: () => void
}

const ConversationItem = ({ conversation, isSelected, onClick }: ConversationItemProps) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left',
        isSelected ? 'bg-imessage-selected text-imessage-selected-foreground' : 'hover:bg-sidebar-accent'
      )}
    >
      <Avatar
        initials={conversation.initials || conversation.name.charAt(0)}
        isGroup={conversation.isGroup}
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

export default ConversationItem

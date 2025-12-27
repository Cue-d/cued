import { Search, SquarePen } from 'lucide-react'
import ConversationItem from './ConversationItem'
import { Conversation } from '@/data/mockData'

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
}

const ConversationList = ({ conversations, selectedId, onSelect }: ConversationListProps) => {
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
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        <div className="space-y-0.5">
          {conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isSelected={selectedId === conversation.id}
              onClick={() => onSelect(conversation.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default ConversationList

import { Info, Mic, Plus } from 'lucide-react'
import { Conversation, formatDateDivider } from '@/data/mockData'
import MessageBubble from './MessageBubble'
import Avatar from './Avatar'

interface MessageThreadProps {
  conversation: Conversation | null
}

const MessageThread = ({ conversation }: MessageThreadProps) => {
  if (!conversation) {
    return (
      <div className="flex-1 h-full bg-imessage-window-bg flex items-center justify-center">
        <p className="text-muted-foreground">Select a conversation to start messaging</p>
      </div>
    )
  }

  // Group messages by date
  const messagesByDate: { [key: string]: typeof conversation.messages } = {}
  conversation.messages.forEach((msg) => {
    const dateKey = msg.timestamp.toDateString()
    if (!messagesByDate[dateKey]) {
      messagesByDate[dateKey] = []
    }
    messagesByDate[dateKey].push(msg)
  })

  return (
    <div className="flex-1 h-full bg-imessage-window-bg flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border bg-imessage-header-bg">
        <div className="flex items-center gap-3">
          <Avatar
            initials={conversation.initials || conversation.name.charAt(0)}
            isGroup={conversation.isGroup}
            size="sm"
          />
          <span className="font-medium text-foreground">{conversation.name}</span>
        </div>
        <button className="p-1.5 hover:bg-sidebar-accent rounded transition-colors">
          <Info className="w-5 h-5 text-primary" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
        <div className="space-y-4">
          {Object.entries(messagesByDate).map(([dateKey, messages]) => (
            <div key={dateKey}>
              <div className="flex items-center justify-center my-4">
                <span className="text-xs text-imessage-timestamp px-3 py-1">
                  {formatDateDivider(new Date(dateKey))}
                </span>
              </div>
              <div className="space-y-1">
                {messages.map((message, idx) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    showTimestamp={idx === messages.length - 1}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input Bar */}
      <div className="p-3 border-t border-border bg-imessage-header-bg">
        <div className="flex items-center gap-2">
          <button className="p-2 hover:bg-sidebar-accent rounded-full transition-colors">
            <Plus className="w-5 h-5 text-primary" />
          </button>
          <div className="flex-1 flex items-center bg-imessage-input-bg border border-imessage-input-border rounded-full px-4 py-2">
            <input
              type="text"
              placeholder="iMessage"
              className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground text-[15px] focus:outline-none"
            />
          </div>
          <button className="p-2 hover:bg-sidebar-accent rounded-full transition-colors">
            <Mic className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default MessageThread

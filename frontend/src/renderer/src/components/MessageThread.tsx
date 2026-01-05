import { Info, Mic, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type Chat, formatDateDivider, formatMessageTime, type Message } from '@/data/types'
import { cn } from '@/lib/utils'
import Avatar from './Avatar'

interface MessageThreadProps {
  chat: Chat | null
  onSendMessage?: (chatId: number, text: string) => Promise<void>
}

interface MessageBubbleProps {
  message: Message
  showTimestamp?: boolean
  isGroupChat?: boolean
  showSenderInfo?: boolean
}

const MessageBubble = ({
  message,
  showTimestamp,
  isGroupChat,
  showSenderInfo
}: MessageBubbleProps) => {
  const showAvatar = isGroupChat && !message.isSent
  const senderInitials = message.senderName
    ? message.senderName
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?'

  return (
    <div className={cn('flex flex-col', message.isSent ? 'items-end' : 'items-start')}>
      {/* Sender name for group chats */}
      {showSenderInfo && !message.isSent && message.senderName && (
        <span className="text-xs text-muted-foreground mb-1 ml-10">{message.senderName}</span>
      )}
      <div className={cn('flex items-end gap-2', message.isSent && 'flex-row-reverse')}>
        {/* Avatar for group chats */}
        {showAvatar && <Avatar initials={senderInitials} size="xs" />}
        <div
          className={cn(
            'max-w-[85%] px-3 py-2 rounded-2xl wrap-break-word',
            message.isSent
              ? 'bg-imessage-bubble-sent text-imessage-bubble-sent-foreground rounded-br-md'
              : 'bg-imessage-bubble-received text-imessage-bubble-received-foreground rounded-bl-md'
          )}
        >
          {message.isLink ? (
            <a
              href={message.text}
              className="text-imessage-link underline text-[15px] leading-relaxed"
              target="_blank"
              rel="noopener noreferrer"
            >
              {message.text}
            </a>
          ) : (
            <p className="text-[15px] leading-relaxed">{message.text}</p>
          )}
        </div>
      </div>
      {showTimestamp && (
        <span className={cn('text-xs text-imessage-timestamp mt-1', showAvatar && 'ml-10')}>
          {formatMessageTime(message.timestamp)}
        </span>
      )}
    </div>
  )
}

const MessageThread = ({ chat, onSendMessage }: MessageThreadProps) => {
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Extract to stable reference for dependency array
  const messagesLength = chat?.messages?.length ?? 0

  // Scroll to bottom immediately when chat changes
  useEffect(() => {
    if (chat?.id) {
      // Immediate scroll when switching chats
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [chat?.id])

  // Smooth scroll when messages update in current conversation
  useEffect(() => {
    if (messagesLength > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messagesLength])

  const handleSend = async () => {
    if (!inputText.trim() || !chat || !onSendMessage || sending) return

    const text = inputText.trim()
    setInputText('')
    setSending(true)

    try {
      await onSendMessage(Number(chat.id), text)
      // Scroll to bottom after sending
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
    } catch (error) {
      console.error('Failed to send message:', error)
      setInputText(text) // Restore text on failure
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!chat) {
    return (
      <div className="flex-1 min-w-0 h-full bg-imessage-window-bg flex items-center justify-center">
        <p className="text-muted-foreground">Select a chat to start messaging</p>
      </div>
    )
  }

  // Group messages by date
  const messagesByDate: { [key: string]: typeof chat.messages } = {}
  chat.messages.forEach((msg) => {
    const dateKey = msg.timestamp.toDateString()
    if (!messagesByDate[dateKey]) {
      messagesByDate[dateKey] = []
    }
    messagesByDate[dateKey].push(msg)
  })

  return (
    <div className="flex-1 min-w-0 h-full bg-imessage-window-bg flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border bg-imessage-header-bg">
        <div className="flex items-center gap-3">
          <Avatar
            initials={chat.initials || chat.name.charAt(0)}
            isGroup={chat.isGroup}
            groupMembers={chat.groupAvatars}
            size="sm"
          />
          <span className="font-medium text-foreground">{chat.name}</span>
        </div>
        <button type="button" className="p-1.5 hover:bg-sidebar-accent rounded transition-colors">
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
                {messages.map((message, idx) => {
                  // Show sender info when sender changes in group chat
                  const prevMsg = idx > 0 ? messages[idx - 1] : null
                  const senderChanged =
                    !message.isSent &&
                    (!prevMsg || prevMsg.isSent || prevMsg.senderName !== message.senderName)

                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      showTimestamp={idx === messages.length - 1}
                      isGroupChat={chat.isGroup}
                      showSenderInfo={senderChanged}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="p-3 border-t border-border bg-imessage-header-bg">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="p-2 hover:bg-sidebar-accent rounded-full transition-colors"
          >
            <Plus className="w-5 h-5 text-primary" />
          </button>
          <div className="flex-1 flex items-center bg-imessage-input-bg border border-imessage-input-border rounded-full px-4 py-2">
            <input
              type="text"
              placeholder="iMessage"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground text-[15px] focus:outline-none disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim() || sending}
            className="p-2 hover:bg-sidebar-accent rounded-full transition-colors disabled:opacity-50"
          >
            <Mic className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default MessageThread

import { AlertCircle, Check, CheckCheck, Clock, Info, Mic, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AttachmentDisplay } from '@/components/Attachments'
import {
  type Chat,
  type DeliveryStatus,
  formatDateDivider,
  formatMessageTime,
  type Message,
  type ReactionType
} from '@/data/types'
import { cn } from '@/lib/utils'
import Avatar from './Avatar'

// Emoji mapping for reaction types (used for reaction message display)
const REACTION_EMOJI: Record<ReactionType, string> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓'
}

// Delivery status indicator component
function DeliveryIndicator({ status }: { status: DeliveryStatus }) {
  switch (status) {
    case 'sending':
      return <Clock className="w-3 h-3 text-muted-foreground" />
    case 'sent':
      return <Check className="w-3 h-3 text-muted-foreground" />
    case 'delivered':
      return <CheckCheck className="w-3 h-3 text-muted-foreground" />
    case 'read':
      return <CheckCheck className="w-3 h-3 text-primary" />
    case 'failed':
      return <AlertCircle className="w-3 h-3 text-destructive" />
    default:
      return null
  }
}

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

  const hasAttachments = message.attachments && message.attachments.length > 0
  const hasText = message.text && message.text.trim().length > 0

  // Check if this is a reaction message (e.g., 'Loved "some text"')
  const isReactionMessage = message.isReaction && message.reactionType

  // For reaction messages, render a compact inline display
  if (isReactionMessage) {
    const emoji = REACTION_EMOJI[message.reactionType!]
    return (
      <div className={cn('flex flex-col', message.isSent ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'flex items-center gap-1 text-xs text-muted-foreground italic py-0.5',
            message.isSent && 'flex-row-reverse'
          )}
        >
          <span>{emoji}</span>
          <span>
            {message.isSent ? 'You' : message.senderName || 'Someone'} reacted to &ldquo;
            {message.reactionQuotedText?.slice(0, 30)}
            {(message.reactionQuotedText?.length || 0) > 30 ? '...' : ''}&rdquo;
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col mb-1', message.isSent ? 'items-end' : 'items-start')}>
      {/* Sender name for group chats */}
      {showSenderInfo && !message.isSent && message.senderName && (
        <span className="text-xs text-muted-foreground mb-1 ml-10">{message.senderName}</span>
      )}
      <div className={cn('flex items-end gap-2', message.isSent && 'flex-row-reverse')}>
        {/* Avatar for group chats */}
        {showAvatar && <Avatar initials={senderInitials} size="xs" />}
        <div className="relative">
          {/* Message bubble */}
          <div
            className={cn(
              'max-w-[85%] px-3 py-2.5 rounded-2xl wrap-break-word break-words',
              message.isSent
                ? 'bg-imessage-bubble-sent text-imessage-bubble-sent-foreground rounded-br-md'
                : 'bg-imessage-bubble-received text-imessage-bubble-received-foreground rounded-bl-md'
            )}
          >
            {/* Attachments (before text) */}
            {hasAttachments && <AttachmentDisplay attachments={message.attachments} />}

            {/* Message text */}
            {hasText &&
              (message.isLink ? (
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
              ))}
          </div>
        </div>
      </div>

      {/* Timestamp and delivery status */}
      {showTimestamp && (
        <div
          className={cn(
            'flex items-center gap-1 mt-1',
            showAvatar && 'ml-10',
            message.isSent && 'flex-row-reverse'
          )}
        >
          <span className="text-xs text-imessage-timestamp">
            {formatMessageTime(message.timestamp)}
          </span>
          {message.isSent && message.deliveryStatus && (
            <DeliveryIndicator status={message.deliveryStatus} />
          )}
        </div>
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
                <span className="text-xs text-imessage-timestamp px-3 py-1 bg-imessage-header-bg rounded-full">
                  {formatDateDivider(new Date(dateKey))}
                </span>
              </div>
              <div className="space-y-2">
                {messages.map((message, idx) => {
                  // Show sender info when sender changes in group chat
                  const prevMsg = idx > 0 ? messages[idx - 1] : null
                  const senderChanged =
                    !message.isSent &&
                    (!prevMsg || prevMsg.isSent || prevMsg.senderName !== message.senderName)

                  // Show timestamp if:
                  // - Last message in the group
                  // - More than 5 minutes since previous message
                  // - Sender changed (for group chats)
                  const timeSincePrev = prevMsg
                    ? Math.abs(message.timestamp.getTime() - prevMsg.timestamp.getTime()) /
                      1000 /
                      60
                    : Infinity
                  const showTimestamp =
                    idx === messages.length - 1 || timeSincePrev > 5 || senderChanged

                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      showTimestamp={showTimestamp}
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

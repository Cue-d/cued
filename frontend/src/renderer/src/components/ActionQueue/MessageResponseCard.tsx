import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { ActionResponse } from '@/api/actions'
import Avatar from '@/components/Avatar'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { type MessageItem, processMessagesWithReactions } from '@/lib/reactions'
import { cn } from '@/lib/utils'

interface MessageResponseCardProps {
  action: ActionResponse
  responseText: string
  onResponseChange: (text: string) => void
  className?: string
}

export interface MessageResponseCardRef {
  focusInput: () => void
}

// UI Components
const ReactionBadges = ({ reactions, isSent }: { reactions: string[]; isSent: boolean }) => {
  const displayReactions = reactions.slice(0, 3)
  return (
    <div
      className={cn(
        'absolute -top-2 flex gap-0.5 px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 shadow-sm text-xs z-10',
        isSent ? 'left-1' : 'right-1'
      )}
    >
      {displayReactions.map((emoji, idx) => (
        <span key={idx}>{emoji}</span>
      ))}
    </div>
  )
}

function getInitials(name: string | null): string {
  if (!name) return '?'
  const parts = name.split(' ').filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.substring(0, 2).toUpperCase()
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp * 1000
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ago`
  }
  if (hours > 0) {
    return `${hours}h ago`
  }
  return 'Just now'
}

export const MessageResponseCard = forwardRef<MessageResponseCardRef, MessageResponseCardProps>(
  function MessageResponseCard({ action, responseText, onResponseChange, className }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => ({
      focusInput: () => {
        textareaRef.current?.focus()
      }
    }))

    useEffect(() => {
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 300)
      return () => clearTimeout(timer)
    }, [])

    useEffect(() => {
      const timer = setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
        }
      }, 0)
      return () => clearTimeout(timer)
    }, [action.recent_messages])

    const personName = action.person_name || action.chat_name || 'Unknown'
    const initials = getInitials(personName)

    // Transform and process messages, sorted chronologically (oldest first, newest at bottom)
    const { displayMessages, reactionsByMessageId } = useMemo(() => {
      const messages: MessageItem[] = [...(action.recent_messages || [])]
        .sort((a, b) => a.date - b.date)
        .map((msg) => ({
          id: msg.id,
          text: msg.text,
          isSent: msg.is_from_me,
          timestamp: msg.date,
          senderName: msg.sender_name
        }))
      return processMessagesWithReactions(messages)
    }, [action.recent_messages])

    return (
      <Card
        className={cn('w-full h-full flex flex-col overflow-hidden gap-0 border p-0', className)}
      >
        {/* Header */}
        <CardHeader className="shrink-0 p-3">
          <div className="flex items-center gap-x-3">
            <Avatar initials={initials} size="sm" />
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm text-foreground truncate">{personName}</h3>
              {action.message_timestamp && (
                <p className="text-xs text-muted-foreground">
                  {formatRelativeTime(action.message_timestamp)}
                </p>
              )}
            </div>
          </div>
        </CardHeader>

        {/* Message Context */}
        <CardContent className="border-t flex-1 p-0 min-h-0">
          <div
            ref={scrollContainerRef}
            className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
            style={{ scrollbarColor: 'rgba(128, 128, 128, 0.5) transparent' }}
          >
            <div className="py-4 px-4 space-y-2">
              {displayMessages.length > 0 ? (
                displayMessages.map((msg) => {
                  const reactions = reactionsByMessageId.get(msg.id)
                  const hasReactions = reactions && reactions.length > 0

                  return (
                    <div
                      key={msg.id}
                      className={cn('flex flex-col', msg.isSent ? 'items-end' : 'items-start')}
                    >
                      {!msg.isSent && msg.senderName && (
                        <p className="text-xs font-medium opacity-70 mb-1 ml-1">{msg.senderName}</p>
                      )}
                      <div className="relative">
                        {hasReactions && (
                          <ReactionBadges reactions={reactions} isSent={msg.isSent} />
                        )}
                        <div
                          className={cn(
                            'max-w-[85%] rounded-2xl px-4 py-2 text-sm',
                            msg.isSent
                              ? 'bg-imessage-bubble-sent text-imessage-bubble-sent-foreground'
                              : 'bg-imessage-bubble-received text-imessage-bubble-received-foreground'
                          )}
                        >
                          <p className="whitespace-pre-wrap wrap-break-word">
                            {msg.text || '[No text]'}
                          </p>
                          <p className="text-[10px] opacity-60 mt-1 text-right">
                            {formatTime(msg.timestamp)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p>No recent messages</p>
                </div>
              )}
            </div>
          </div>
        </CardContent>

        {/* Response Input */}
        <CardFooter className="p-3 bg-transparent">
          <Textarea
            ref={textareaRef}
            value={responseText}
            onChange={(e) => onResponseChange(e.target.value)}
            placeholder="Type your response... (swipe right to send)"
            className="min-h-[80px] max-h-[150px] resize-none bg-background"
            onKeyDown={(e) => {
              // Prevent card swipe while typing
              e.stopPropagation()
            }}
          />
        </CardFooter>
      </Card>
    )
  }
)

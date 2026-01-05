import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ActionResponse } from '@/api/actions'
import Avatar from '@/components/Avatar'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
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
      // Auto-focus the textarea when the card mounts
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 300)
      return () => clearTimeout(timer)
    }, [])

    useEffect(() => {
      // Scroll to bottom when messages change or component mounts
      const timer = setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
        }
      }, 0)
      return () => clearTimeout(timer)
    }, [action.recent_messages])

    const personName = action.person_name || action.chat_name || 'Unknown'
    const initials = getInitials(personName)
    const recentMessages = action.recent_messages || []

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
              {recentMessages.length > 0 ? (
                recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-2 text-sm',
                      msg.is_from_me
                        ? 'ml-auto bg-imessage-bubble-sent text-imessage-bubble-sent-foreground'
                        : 'mr-auto bg-imessage-bubble-received text-imessage-bubble-received-foreground'
                    )}
                  >
                    {!msg.is_from_me && msg.sender_name && (
                      <p className="text-xs font-medium opacity-70 mb-1">{msg.sender_name}</p>
                    )}
                    <p className="whitespace-pre-wrap wrap-break-word">{msg.text || '[No text]'}</p>
                    <p className="text-[10px] opacity-60 mt-1 text-right">{formatTime(msg.date)}</p>
                  </div>
                ))
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

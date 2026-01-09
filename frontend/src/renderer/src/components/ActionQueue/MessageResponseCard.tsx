import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ActionResponse, AttachmentResponse } from '@/api/actions'
import { fetchActionMessages } from '@/api/actions'
import type { MessageResponse } from '@/api/client'
import { AttachmentDisplay } from '@/components/Attachments'
import Avatar from '@/components/Avatar'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { renderTextWithLinks } from '@/lib/linkDetection'
import { type MessageItem, processMessagesWithReactions } from '@/lib/reactions'
import { cn, getInitials } from '@/lib/utils'

const PAGE_SIZE = 15

interface MessageResponseCardProps {
  action: ActionResponse
  responseText: string
  onResponseChange: (text: string) => void
  className?: string
  autoFocus?: boolean
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
        'absolute -top-3 flex gap-0.5 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700 shadow-sm text-sm z-10 border border-gray-200 dark:border-gray-600',
        isSent ? '-left-3' : '-right-3'
      )}
    >
      {displayReactions.map((emoji, idx) => (
        <span key={idx}>{emoji}</span>
      ))}
    </div>
  )
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

// Delivery status indicator for sent messages
const DeliveryStatus = ({
  isRead,
  isDelivered,
  error
}: {
  isRead?: boolean
  isDelivered?: boolean
  error?: number
}) => {
  if (error && error !== 0) {
    return (
      <span className="text-red-500" title="Failed to send">
        !
      </span>
    )
  }
  if (isRead) {
    return (
      <span className="text-blue-400" title="Read">
        Read
      </span>
    )
  }
  if (isDelivered) {
    return (
      <span className="opacity-60" title="Delivered">
        Delivered
      </span>
    )
  }
  return (
    <span className="opacity-40" title="Sent">
      Sent
    </span>
  )
}

export const MessageResponseCard = forwardRef<MessageResponseCardRef, MessageResponseCardProps>(
  function MessageResponseCard(
    { action, responseText, onResponseChange, className, autoFocus = true },
    ref
  ) {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    // Pagination state
    const [messages, setMessages] = useState<MessageResponse[]>(action.recent_messages || [])
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(true)
    const loadingRef = useRef(false) // Prevent concurrent loads

    // Reset messages when action changes
    useEffect(() => {
      setMessages(action.recent_messages || [])
      setHasMore(true)
    }, [action.id, action.recent_messages])

    useImperativeHandle(ref, () => ({
      focusInput: () => {
        textareaRef.current?.focus()
      }
    }))

    useEffect(() => {
      if (!autoFocus) return
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 300)
      return () => clearTimeout(timer)
    }, [autoFocus])

    // Scroll to bottom on initial load
    useEffect(() => {
      const timer = setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
        }
      }, 0)
      return () => clearTimeout(timer)
    }, [action.id])

    // Load more messages when scrolling to top
    const loadMoreMessages = useCallback(async () => {
      if (loadingRef.current || !hasMore || !action.id) return
      loadingRef.current = true
      setIsLoadingMore(true)

      try {
        const offset = messages.length
        const olderMessages = await fetchActionMessages(action.id, PAGE_SIZE, offset)

        if (olderMessages.length === 0) {
          setHasMore(false)
        } else {
          // Preserve scroll position by measuring before and after
          const container = scrollContainerRef.current
          const previousScrollHeight = container?.scrollHeight || 0

          // Merge messages, avoiding duplicates by ID
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id))
            const newMessages = olderMessages.filter((m) => !existingIds.has(m.id))
            return [...newMessages, ...prev]
          })

          // Restore scroll position after DOM updates
          requestAnimationFrame(() => {
            if (container) {
              const newScrollHeight = container.scrollHeight
              container.scrollTop = newScrollHeight - previousScrollHeight
            }
          })

          // If we got fewer messages than requested, there are no more
          if (olderMessages.length < PAGE_SIZE) {
            setHasMore(false)
          }
        }
      } catch (error) {
        console.error('Failed to load more messages:', error)
      } finally {
        setIsLoadingMore(false)
        loadingRef.current = false
      }
    }, [action.id, messages.length, hasMore])

    // Handle scroll to detect when user reaches the top
    const handleScroll = useCallback(() => {
      const container = scrollContainerRef.current
      if (!container || isLoadingMore || !hasMore) return

      // Trigger load when scrolled near the top (within 50px)
      if (container.scrollTop < 50) {
        loadMoreMessages()
      }
    }, [isLoadingMore, hasMore, loadMoreMessages])

    const personName = action.person_name || action.chat_name || 'Unknown'
    const initials = getInitials(personName)

    // Transform and process messages, sorted chronologically (oldest first, newest at bottom)
    // Keep track of attachments separately since MessageItem doesn't include them
    const { displayMessages, reactionsByMessageId, attachmentsByMessageId } = useMemo(() => {
      const sortedMessages = [...messages].sort((a, b) => a.date - b.date)

      // Build a map of attachments by message ID before processing reactions
      const attachmentsMap = new Map<number, AttachmentResponse[]>()
      for (const msg of sortedMessages) {
        if (msg.attachments && msg.attachments.length > 0) {
          attachmentsMap.set(msg.id, msg.attachments)
        }
      }

      const messageItems: MessageItem[] = sortedMessages.map((msg) => ({
        id: msg.id,
        text: msg.text,
        isSent: msg.is_from_me,
        timestamp: msg.date,
        senderName: msg.sender_name,
        isRead: msg.is_read,
        dateRead: msg.date_read,
        isDelivered: msg.is_delivered,
        dateDelivered: msg.date_delivered,
        error: msg.error
      }))

      const processed = processMessagesWithReactions(messageItems)

      return {
        displayMessages: processed.displayMessages,
        reactionsByMessageId: processed.reactionsByMessageId,
        attachmentsByMessageId: attachmentsMap
      }
    }, [messages])

    return (
      <Card
        className={cn('w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0', className)}
      >
        {/* Header */}
        <CardHeader className="shrink-0 p-4">
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
        <CardContent className="flex-1 p-0 min-h-0">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
            style={{ scrollbarColor: 'rgba(128, 128, 128, 0.5) transparent' }}
          >
            <div className="py-4 px-4 space-y-2">
              {/* Loading indicator at the top */}
              {isLoadingMore && (
                <div className="flex justify-center py-2">
                  <div className="text-xs text-muted-foreground">Loading older messages...</div>
                </div>
              )}
              {/* "Beginning of conversation" indicator */}
              {!hasMore && messages.length > 0 && (
                <div className="flex justify-center py-2">
                  <div className="text-xs text-muted-foreground">Beginning of conversation</div>
                </div>
              )}
              {displayMessages.length > 0 ? (
                displayMessages.map((msg) => {
                  const reactions = reactionsByMessageId.get(msg.id)
                  const hasReactions = reactions && reactions.length > 0
                  const msgAttachments = attachmentsByMessageId.get(msg.id)
                  const hasAttachments = msgAttachments && msgAttachments.length > 0

                  // Don't show "[attachment]" placeholder text when we have actual attachments
                  const hasText =
                    msg.text &&
                    msg.text.trim().length > 0 &&
                    !(hasAttachments && msg.text.trim() === '[attachment]')

                  // Convert API attachments to component format
                  const attachments = hasAttachments
                    ? msgAttachments.map((a) => ({
                        id: a.id,
                        filename: a.filename,
                        size: a.size,
                        isImage: a.is_image
                      }))
                    : []

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex flex-col w-full',
                        msg.isSent ? 'items-end' : 'items-start',
                        hasReactions && 'mb-2'
                      )}
                    >
                      {!msg.isSent && msg.senderName && (
                        <p className="text-xs font-medium opacity-70 mb-1 ml-1">{msg.senderName}</p>
                      )}
                      <div
                        className={cn('flex w-full', msg.isSent ? 'justify-end' : 'justify-start')}
                      >
                        <div
                          className={cn(
                            'relative rounded-2xl px-4 py-2 text-sm break-words',
                            msg.isSent
                              ? 'bg-imessage-bubble-sent text-imessage-bubble-sent-foreground'
                              : 'bg-imessage-bubble-received text-imessage-bubble-received-foreground'
                          )}
                          style={{ maxWidth: '85%', width: 'fit-content' }}
                        >
                          {hasReactions && (
                            <ReactionBadges reactions={reactions} isSent={msg.isSent} />
                          )}
                          {hasAttachments && (
                            <AttachmentDisplay
                              attachments={attachments}
                              maxImageSize={200}
                              compact
                            />
                          )}
                          {hasText && msg.text && (
                            <p
                              className="whitespace-pre-wrap break-words select-text"
                              data-selectable="true"
                            >
                              {renderTextWithLinks(msg.text, 'whitespace-pre-wrap break-words')}
                            </p>
                          )}
                          {!hasText && !hasAttachments && (
                            <p className="whitespace-pre-wrap break-words">[No text]</p>
                          )}
                          <p
                            className={cn(
                              'text-[10px] opacity-60 mt-1 flex items-center gap-1',
                              msg.isSent ? 'justify-end' : 'justify-start'
                            )}
                          >
                            {formatTime(msg.timestamp)}
                            {msg.isSent && (
                              <>
                                <span className="mx-0.5">·</span>
                                <DeliveryStatus
                                  isRead={msg.isRead}
                                  isDelivered={msg.isDelivered}
                                  error={msg.error}
                                />
                              </>
                            )}
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
        <CardFooter className="p-4 bg-transparent" data-selectable="true">
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

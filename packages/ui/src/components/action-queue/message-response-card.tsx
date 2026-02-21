import * as React from "react"
import { CheckCircle2 } from 'lucide-react'
import {
  type ActionPlatform,
  type DisplayMessage,
  formatTime,
  formatRelativeTime,
} from "@cued/shared"

/** Format timestamp as iMessage-style divider: "Today 3:45 PM", "Yesterday", "Mon", "Nov 18 at 2:37 AM" */
function formatDividerTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const time = formatTime(timestamp)

  // Today: "Today 3:45 PM"
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  if (isToday) return `Today ${time}`

  // Yesterday
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  if (isYesterday) return "Yesterday"

  // Within last 7 days: "Mon"
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" })
  }

  // Older: "Nov 18 at 2:37 AM"
  const monthDay = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
  return `${monthDay} at ${time}`
}
import { cn } from "../../lib/utils"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { MessageBubble, type MessageSpacing } from "./message-response-card/message-bubble"
import { ResponseInput } from "./message-response-card/response-input"
import { OpenInAppButton } from "./open-in-app-button"
import { ParticipantsHoverCard, type Participant } from "./participants-hover-card"
import type { OpenInAppConfig } from "../../actions/types"

/** Re-export sub-components for advanced usage */
export { PlatformBadge, type PlatformBadgeProps } from "./message-response-card/platform-badge"
export { MessageBubble, DeliveryStatus, type MessageBubbleProps, type MessageSpacing } from "./message-response-card/message-bubble"
export { ResponseInput, type ResponseInputProps } from "./message-response-card/response-input"

export interface MessageResponseCardProps {
  /** Person name for header */
  personName: string
  /** Timestamp for relative time display */
  messageTimestamp?: number
  /** Array of messages to display */
  messages: DisplayMessage[]
  /** Current response text */
  responseText: string
  /** Called when response text changes */
  onResponseChange: (text: string) => void
  /** Called when user triggers send */
  onSend?: () => void
  /** Called when user dismisses the action */
  onDismiss?: () => void
  /** Whether a send is in progress */
  isSending?: boolean
  /** Optional class name */
  className?: string
  /** Auto-focus textarea on mount */
  autoFocus?: boolean
  /** Current platform for sending */
  platform?: ActionPlatform
  /** Available platforms (from contact handles) */
  availablePlatforms?: ActionPlatform[]
  /** Called when platform changes */
  onPlatformChange?: (platform: ActionPlatform) => void
  /** Open-in-app deeplink config */
  openInApp?: OpenInAppConfig | null
  /** Called when a link in a message is clicked. Receives the URL. */
  onLinkClick?: (url: string) => void
  /** Conversation participants (for hover card on header) */
  participants?: Participant[]
  /** Primary contact ID (for DM header click) */
  contactId?: string | null
  /** Called when a contact name is clicked */
  onContactClick?: (contactId: string) => void
  /** Whether there are older messages to load */
  hasMore?: boolean
  /** Called when user wants to load older messages */
  onLoadMore?: () => void
  /** Whether older messages are currently loading */
  isLoadingMore?: boolean
  /** Whether this action has been completed (message sent) */
  isCompleted?: boolean
  /** When true, hides response input and shows read-only status (history view) */
  readOnly?: boolean
  /** Resolution timestamp for read-only status display */
  resolvedAt?: number | null
  /** Resolution status label for read-only display */
  resolvedStatus?: "completed" | "discarded" | null
}

export interface MessageResponseCardRef {
  focusInput: () => void
}

/**
 * MessageResponseCard component for action queue.
 * Displays message history and response textarea.
 * Composed of PlatformBadge, MessageBubble, DraftSelector, and ResponseInput.
 */
export const MessageResponseCard = React.forwardRef<
  MessageResponseCardRef,
  MessageResponseCardProps
>(function MessageResponseCard(
  {
    personName,
    messageTimestamp,
    messages,
    responseText,
    onResponseChange,
    onSend,
    onDismiss,
    isSending = false,
    className,
    autoFocus = true,
    platform,
    availablePlatforms,
    onPlatformChange,
    openInApp,
    onLinkClick,
    participants,
    contactId,
    onContactClick,
    hasMore,
    onLoadMore,
    isLoadingMore,
    isCompleted = false,
    readOnly = false,
    resolvedAt,
    resolvedStatus,
  },
  ref
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const prevScrollHeightRef = React.useRef<number>(0)
  const prevMessageCountRef = React.useRef<number>(0)
  const initialScrollDoneRef = React.useRef(false)

  React.useImperativeHandle(ref, () => ({
    focusInput: () => {
      textareaRef.current?.focus()
    },
  }))

  React.useEffect(() => {
    if (!autoFocus) return
    const timer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 300)
    return () => clearTimeout(timer)
  }, [autoFocus])

  // Scroll to bottom on initial load, preserve position when older messages prepend
  React.useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const prevCount = prevMessageCountRef.current
    const newCount = messages.length

    if (prevCount === 0 && newCount > 0) {
      // Initial load — scroll to bottom
      initialScrollDoneRef.current = false
      const timer = setTimeout(() => {
        el.scrollTop = el.scrollHeight
        initialScrollDoneRef.current = true
        prevMessageCountRef.current = newCount
        prevScrollHeightRef.current = el.scrollHeight
      }, 0)
      return () => clearTimeout(timer)
    }

    if (newCount > prevCount && prevCount > 0 && initialScrollDoneRef.current) {
      // Older messages were prepended — preserve scroll position
      const prevHeight = prevScrollHeightRef.current
      const newHeight = el.scrollHeight
      el.scrollTop += newHeight - prevHeight
    }

    prevMessageCountRef.current = newCount
    prevScrollHeightRef.current = el.scrollHeight
  }, [messages])

  // Auto-load older messages when user scrolls near the top
  React.useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const handleScroll = () => {
      if (el.scrollTop < 80 && hasMore && !isLoadingMore && onLoadMore) {
        onLoadMore()
      }
    }

    el.addEventListener("scroll", handleScroll, { passive: true })
    return () => el.removeEventListener("scroll", handleScroll)
  }, [hasMore, isLoadingMore, onLoadMore])

  // Intercept link clicks in message bubbles
  const handleContainerClick = React.useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest("a")
      if (target && target.href && onLinkClick) {
        e.preventDefault()
        onLinkClick(target.href)
      }
    },
    [onLinkClick]
  )

  // Sort messages chronologically (oldest first)
  const sortedMessages = React.useMemo(
    () => [...messages].sort((a, b) => a.sentAt - b.sentAt),
    [messages]
  )

  function shouldShowSenderName(msg: DisplayMessage, idx: number): boolean {
    if (msg.isFromMe) return false
    if (!msg.senderName) return false
    if (idx === 0) return true
    const prevMsg = sortedMessages[idx - 1]
    if (prevMsg.isFromMe) return true
    return prevMsg.senderName !== msg.senderName
  }

  function getMessageSpacing(msg: DisplayMessage, idx: number): MessageSpacing {
    if (idx === 0) return "normal"
    const prevMsg = sortedMessages[idx - 1]

    // Different sender direction = wide gap
    if (msg.isFromMe !== prevMsg.isFromMe) return "wide"

    // Same sender direction but different person (group chat) = wide gap
    if (!msg.isFromMe && msg.senderContactId !== prevMsg.senderContactId) return "wide"

    // Same sender - check time gap (>2 min = normal spacing)
    const timeDiffMinutes = (msg.sentAt - prevMsg.sentAt) / 1000 / 60
    return timeDiffMinutes > 2 ? "normal" : "tight"
  }

  function shouldShowTimestamp(msg: DisplayMessage, idx: number): boolean {
    if (idx === 0) return true
    const prevMsg = sortedMessages[idx - 1]

    // Only show on significant time gaps (>1 hour), not on sender changes
    const timeDiffMinutes = (msg.sentAt - prevMsg.sentAt) / 1000 / 60
    if (timeDiffMinutes <= 60) return false

    // Deduplicate: don't show if label would be identical to the previous shown timestamp
    const thisLabel = formatDividerTime(msg.sentAt)
    // Walk back to find the last message that showed a timestamp
    for (let i = idx - 1; i >= 0; i--) {
      const prev = sortedMessages[i]
      const prevPrev = i > 0 ? sortedMessages[i - 1] : undefined
      // Check if this previous message would have shown a timestamp
      if (i === 0 || (prevPrev && (prev.sentAt - prevPrev.sentAt) / 1000 / 60 > 60)) {
        return formatDividerTime(prev.sentAt) !== thisLabel
      }
    }
    return true
  }

  return (
    <Card
      className={cn(
        "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0 bg-transparent relative",
        className
      )}
    >
      {isCompleted && !readOnly && (
        <div
          className="absolute inset-0 z-10 pointer-events-none rounded-[inherit]"
          style={{ backgroundColor: "#1B5E3D", opacity: 0.08 }}
        />
      )}
      {/* Header - fixed h-10 to align with PanelHeader in left column */}
      <CardHeader className="shrink-0 h-10 py-0 flex items-center relative z-10">
        <div className="flex items-center justify-center w-full">
          {participants && participants.length > 0 ? (
            <ParticipantsHoverCard
              participants={participants}
              onContactClick={onContactClick}
            >
              <h3 className="font-semibold text-sm text-foreground truncate hover:underline cursor-pointer">
                {personName}
              </h3>
            </ParticipantsHoverCard>
          ) : contactId && onContactClick ? (
            <button
              type="button"
              onClick={() => onContactClick(contactId)}
              className="font-semibold text-sm text-foreground truncate hover:underline cursor-pointer"
            >
              {personName}
            </button>
          ) : (
            <h3 className="font-semibold text-sm text-foreground truncate">
              {personName}
            </h3>
          )}
          <div className="absolute right-2 top-2">
            {openInApp && <OpenInAppButton config={openInApp} tooltip="⌘O" />}
          </div>
        </div>
      </CardHeader>

      {/* Message Context */}
      <CardContent className="flex-1 p-0 min-h-0">
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
          style={{ scrollbarColor: "rgba(128, 128, 128, 0.5) transparent" }}
          onClick={handleContainerClick}
        >
          <div className="py-4 px-4">
            {isLoadingMore && (
              <div className="flex justify-center mb-4">
                <span className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              </div>
            )}
            {sortedMessages.length > 0 ? (
              sortedMessages.map((msg, idx) => {
                const showTime = shouldShowTimestamp(msg, idx)
                return (
                  <React.Fragment key={msg._id}>
                    {showTime && (
                      <div className="flex justify-center my-4">
                        <span className="text-[10px] text-muted-foreground font-medium tracking-tight tabular-nums">
                          {formatDividerTime(msg.sentAt)}
                        </span>
                      </div>
                    )}
                    <MessageBubble
                      id={msg._id}
                      content={msg.content}
                      isFromMe={msg.isFromMe}
                      sentAt={msg.sentAt}
                      senderName={msg.senderName}
                      senderContactId={msg.senderContactId}
                      status={msg.status}
                      reactions={msg.reactions}
                      showSenderName={shouldShowSenderName(msg, idx)}
                      spacing={showTime ? "normal" : getMessageSpacing(msg, idx)}
                      platform={platform}
                      onContactClick={onContactClick}
                    />
                  </React.Fragment>
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

      {/* Response Input, Completed State, or Read-Only Status */}
      <CardFooter className="p-2 bg-transparent" data-selectable="true">
        {readOnly ? (
          <div className="flex items-center justify-between w-full py-2 px-1">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} strokeWidth={1.5} className={resolvedStatus === "discarded" ? "text-muted-foreground" : "text-[#1B5E3D]"} />
              <span className="text-sm font-medium text-muted-foreground">
                {resolvedStatus === "discarded" ? "Skipped" : "Sent"}
              </span>
            </div>
            {resolvedAt && (
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(resolvedAt)}
              </span>
            )}
          </div>
        ) : isCompleted ? (
          <div className="flex items-center justify-center gap-2 w-full py-2">
            <CheckCircle2 size={16} strokeWidth={1.5} className="text-[#1B5E3D]" />
            <span className="text-sm font-medium text-muted-foreground">
              Message queued
            </span>
          </div>
        ) : (
          <ResponseInput
            value={responseText}
            onChange={onResponseChange}
            onSend={onSend}
            isSending={isSending}
            placeholder="Send a message..."
            textareaRef={textareaRef}
          />
        )}
      </CardFooter>
    </Card>
  )
})

export default MessageResponseCard

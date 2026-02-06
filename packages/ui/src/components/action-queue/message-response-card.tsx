import * as React from "react"
import {
  type ActionPlatform,
  type DisplayMessage,
} from "@cued/shared"
import { cn } from "../../lib/utils"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { MessageBubble } from "./message-response-card/message-bubble"
import { PlatformBadge } from "./message-response-card/platform-badge"
import { ResponseInput } from "./message-response-card/response-input"
import { OpenInAppButton } from "./open-in-app-button"
import type { OpenInAppConfig } from "../../actions/types"

/** Re-export sub-components for advanced usage */
export { PlatformBadge, type PlatformBadgeProps } from "./message-response-card/platform-badge"
export { MessageBubble, ReactionBadges, DeliveryStatus, type MessageBubbleProps, type MessageSpacing } from "./message-response-card/message-bubble"
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
  },
  ref
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)

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

  // Scroll to bottom on initial load
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop =
          scrollContainerRef.current.scrollHeight
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [messages])

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

  function getMessageSpacing(msg: DisplayMessage, idx: number): "tight" | "normal" | "wide" {
    if (idx === 0) return "normal"
    const prevMsg = sortedMessages[idx - 1]

    // Different sender direction = wide gap
    if (msg.isFromMe !== prevMsg.isFromMe) return "wide"

    // Same sender direction but different person (group chat) = wide gap
    if (!msg.isFromMe && msg.senderName !== prevMsg.senderName) return "wide"

    // Same sender - check time gap (>2 min = normal spacing)
    const timeDiffMinutes = (msg.sentAt - prevMsg.sentAt) / 1000 / 60
    return timeDiffMinutes > 2 ? "normal" : "tight"
  }

  return (
    <Card
      className={cn(
        "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0 bg-transparent",
        className
      )}
    >
      {/* Header */}
      <CardHeader className="shrink-0 py-3">
        <div className="flex items-center">
          <div className="flex-1" />
          <div className="flex items-center justify-center">
            <h3 className="font-semibold text-sm text-foreground truncate">
              {personName}
            </h3>

            {/* Platform Selector */}
            {platform && (
              <PlatformBadge
                platform={platform}
                availablePlatforms={availablePlatforms}
                onPlatformChange={onPlatformChange}
              />
            )}
          </div>
          <div className="flex-1 flex justify-end">
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
            {sortedMessages.length > 0 ? (
              sortedMessages.map((msg, idx) => (
                <MessageBubble
                  key={msg._id}
                  id={msg._id}
                  content={msg.content}
                  isFromMe={msg.isFromMe}
                  sentAt={msg.sentAt}
                  senderName={msg.senderName}
                  status={msg.status}
                  reactions={msg.reactions}
                  showSenderName={shouldShowSenderName(msg, idx)}
                  spacing={getMessageSpacing(msg, idx)}
                  platform={platform}
                />
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
      <CardFooter className="p-2 bg-transparent" data-selectable="true">
        <ResponseInput
          value={responseText}
          onChange={onResponseChange}
          onSend={onSend}
          isSending={isSending}
          placeholder="Send a message..."
          textareaRef={textareaRef}
        />
      </CardFooter>
    </Card>
  )
})

export default MessageResponseCard

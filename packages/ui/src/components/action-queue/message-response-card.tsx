"use client"

import * as React from "react"
import {
  getInitials,
  formatRelativeTime,
  type ActionPlatform,
  type DisplayMessage,
} from "@cued/shared"
import { cn } from "../../lib/utils"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { MessageBubble } from "./message-response-card/message-bubble"
import { PlatformBadge } from "./message-response-card/platform-badge"
import { ResponseInput } from "./message-response-card/response-input"

/** Re-export sub-components for advanced usage */
export { PlatformBadge, PLATFORM_ICONS, type PlatformBadgeProps } from "./message-response-card/platform-badge"
export { MessageBubble, ReactionBadges, DeliveryStatus, type MessageBubbleProps } from "./message-response-card/message-bubble"
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
    className,
    autoFocus = true,
    platform,
    availablePlatforms,
    onPlatformChange,
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

  const initials = getInitials(personName)

  // Sort messages chronologically (oldest first)
  const sortedMessages = React.useMemo(
    () => [...messages].sort((a, b) => a.sentAt - b.sentAt),
    [messages]
  )

  return (
    <Card
      className={cn(
        "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0",
        className
      )}
    >
      {/* Header */}
      <CardHeader className="shrink-0 p-4">
        <div className="flex items-center gap-x-3">
          <Avatar size="sm">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-foreground truncate">
              {personName}
            </h3>
            {messageTimestamp && (
              <p className="text-xs text-muted-foreground">
                {formatRelativeTime(messageTimestamp)}
              </p>
            )}
          </div>

          {/* Platform Selector */}
          {platform && (
            <PlatformBadge
              platform={platform}
              availablePlatforms={availablePlatforms}
              onPlatformChange={onPlatformChange}
            />
          )}
        </div>
      </CardHeader>

      {/* Message Context */}
      <CardContent className="flex-1 p-0 min-h-0">
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
          style={{ scrollbarColor: "rgba(128, 128, 128, 0.5) transparent" }}
        >
          <div className="py-4 px-4 space-y-2">
            {sortedMessages.length > 0 ? (
              sortedMessages.map((msg) => (
                <MessageBubble
                  key={msg._id}
                  id={msg._id}
                  content={msg.content}
                  isFromMe={msg.isFromMe}
                  sentAt={msg.sentAt}
                  senderName={msg.senderName}
                  status={msg.status}
                  reactions={msg.reactions}
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
      <CardFooter className="p-4 bg-transparent" data-selectable="true">
        <ResponseInput
          value={responseText}
          onChange={onResponseChange}
          placeholder="Type your response... (swipe right to send)"
          textareaRef={textareaRef}
        />
      </CardFooter>
    </Card>
  )
})

export default MessageResponseCard

import * as React from "react"
import { CircleCheck } from "lucide-react"
import {
  type ActionPlatform,
  type DisplayMessage,
} from "@cued/shared"
import { cn } from "../../lib/utils"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { InboxMessageBubble, type InboxMessageSpacing } from "../unified-inbox/message-bubble"
import type { InboxMessage } from "../unified-inbox/message-types"
import { PlatformBadge } from "./message-response-card/platform-badge"
import { ResponseInput } from "./message-response-card/response-input"
import { OpenInAppButton } from "./open-in-app-button"
import { ParticipantsHoverCard, type Participant } from "./participants-hover-card"
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
  /** Conversation participants (for hover card on header) */
  participants?: Participant[]
  /** Primary contact ID (for DM header click) */
  contactId?: string | null
  /** Called when a contact name is clicked */
  onContactClick?: (contactId: string) => void
  /** Whether this action has been completed (message sent) */
  isCompleted?: boolean
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
    isCompleted = false,
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

  // Convert DisplayMessage to InboxMessage for the shared bubble component
  const inboxMessages: InboxMessage[] = React.useMemo(
    () => sortedMessages.map((msg) => ({
      _id: msg._id,
      content: msg.content ?? "",
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      platform: (platform ?? "imessage") as InboxMessage["platform"],
      sender: msg.senderName ? {
        _id: msg.senderContactId ?? msg._id,
        displayName: msg.senderName,
      } : null,
      reactions: msg.reactions ?? null,
      status: msg.status,
    })),
    [sortedMessages, platform]
  )

  function shouldShowSenderName(msg: InboxMessage, idx: number): boolean {
    if (msg.isFromMe) return false
    if (!msg.sender?.displayName) return false
    if (idx === 0) return true
    const prevMsg = inboxMessages[idx - 1]
    if (prevMsg.isFromMe) return true
    return prevMsg.sender?.displayName !== msg.sender?.displayName
  }

  function getMessageSpacing(msg: InboxMessage, idx: number): InboxMessageSpacing {
    if (idx === 0) return "normal"
    const prevMsg = inboxMessages[idx - 1]

    // Different sender direction = wide gap
    if (msg.isFromMe !== prevMsg.isFromMe) return "wide"

    // Same sender direction but different person (group chat) = wide gap
    if (!msg.isFromMe && msg.sender?._id !== prevMsg.sender?._id) return "wide"

    // Same sender - check time gap (>2 min = normal spacing)
    const timeDiffMinutes = (msg.sentAt - prevMsg.sentAt) / 1000 / 60
    return timeDiffMinutes > 2 ? "normal" : "tight"
  }

  return (
    <Card
      className={cn(
        "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0 bg-transparent relative",
        className
      )}
    >
      {isCompleted && (
        <div
          className="absolute inset-0 z-10 pointer-events-none rounded-[inherit]"
          style={{ backgroundColor: "#1B5E3D", opacity: 0.08 }}
        />
      )}
      {/* Header - fixed h-10 to align with PanelHeader in left column */}
      <CardHeader className="shrink-0 h-10 py-0 flex items-center">
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
            {inboxMessages.length > 0 ? (
              inboxMessages.map((msg, idx) => (
                <InboxMessageBubble
                  key={msg._id}
                  message={msg}
                  showTimestamp={true}
                  showSenderName={shouldShowSenderName(msg, idx)}
                  spacing={getMessageSpacing(msg, idx)}
                  onContactClick={onContactClick}
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

      {/* Response Input or Completed State */}
      <CardFooter className="p-2 bg-transparent" data-selectable="true">
        {isCompleted ? (
          <div className="flex items-center justify-center gap-2 w-full py-2">
            <CircleCheck className="w-4 h-4 text-[#1B5E3D]" />
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

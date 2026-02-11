import { cn } from "../../lib/utils"
import type { InboxMessage } from "./message-types"
import type React from "react"

export type InboxMessageSpacing = "tight" | "normal" | "wide"

interface InboxMessageBubbleProps {
  message: InboxMessage
  showTimestamp?: boolean
  showSenderName?: boolean
  spacing?: InboxMessageSpacing
  onContactClick?: (contactId: string) => void
}

const SPACING_CLASSES: Record<InboxMessageSpacing, string> = {
  tight: "mt-0.5",
  normal: "mt-2",
  wide: "mt-4",
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function InboxMessageBubble({
  message,
  showTimestamp = false,
  showSenderName = false,
  spacing = "normal",
  onContactClick,
}: InboxMessageBubbleProps): React.ReactElement {
  const senderName = message.sender?.displayName
  const senderId = message.sender?._id
  const hasContent = message.content.trim().length > 0

  return (
    <div
      className={cn(
        "flex flex-col group",
        message.isFromMe ? "items-end" : "items-start",
        SPACING_CLASSES[spacing]
      )}
    >
      {/* Sender name for received messages */}
      {showSenderName && !message.isFromMe && senderName && (
        senderId && onContactClick ? (
          <button
            type="button"
            onClick={() => onContactClick(senderId)}
            className="text-xs font-medium text-muted-foreground mb-1.5 ml-1 hover:underline hover:text-foreground transition-colors cursor-pointer text-left"
          >
            {senderName}
          </button>
        ) : (
          <span className="text-xs font-medium text-muted-foreground mb-1.5 ml-1">
            {senderName}
          </span>
        )
      )}

      {/* Message bubble - only show if there's content */}
      {hasContent && (
        <div
          className={cn(
            "max-w-[75%] px-4 py-2.5 rounded-[8px] wrap-break-words transition-all duration-200",
            message.isFromMe
              ? "bg-primary text-primary-foreground"
              : "bg-background text-foreground shadow-minimal"
          )}
        >
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
      )}

      {/* Timestamp */}
      {showTimestamp && (
        <span className="text-[11px] font-medium text-muted-foreground mt-1.5 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          {formatMessageTime(message.sentAt)}
        </span>
      )}
    </div>
  )
}

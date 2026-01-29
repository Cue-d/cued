import { cn } from "../../lib/utils"
import type { InboxMessage } from "./message-types"
import type React from "react"

interface InboxMessageBubbleProps {
  message: InboxMessage
  showTimestamp?: boolean
  showSenderName?: boolean
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function InboxMessageBubble({
  message,
  showTimestamp = false,
  showSenderName = false,
}: InboxMessageBubbleProps): React.ReactElement {
  const senderName = message.sender?.displayName
  const hasContent = message.content.trim().length > 0

  return (
    <div
      className={cn(
        "flex flex-col mb-1.5 group",
        message.isFromMe ? "items-end" : "items-start"
      )}
    >
      {/* Sender name for received messages */}
      {showSenderName && !message.isFromMe && senderName && (
        <span className="text-xs font-medium text-muted-foreground mb-1.5 ml-1">
          {senderName}
        </span>
      )}

      {/* Message bubble - only show if there's content */}
      {hasContent && (
        <div
          className={cn(
            "max-w-[75%] px-4 py-2.5 rounded-2xl wrap-break-words transition-all duration-200",
            message.isFromMe
              ? "bg-primary text-primary-foreground rounded-br-lg"
              : "bg-muted/70 text-foreground rounded-bl-lg border border-border/20"
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

import type React from "react"
import { cn } from "../../lib/utils"
import type { Message } from "./message-types"

interface MessageBubbleProps {
  message: Message
  showTimestamp?: boolean
  showSenderName?: boolean
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function MessageBubble({
  message,
  showTimestamp = false,
  showSenderName = false,
}: MessageBubbleProps): React.ReactElement {
  const senderName = message.sender?.displayName

  return (
    <div
      className={cn(
        "flex flex-col mb-1",
        message.isFromMe ? "items-end" : "items-start"
      )}
    >
      {/* Sender name for received messages */}
      {showSenderName && !message.isFromMe && senderName && (
        <span className="text-xs text-muted-foreground mb-1 ml-1">
          {senderName}
        </span>
      )}

      {/* Message bubble */}
      <div
        className={cn(
          "max-w-[75%] px-3 py-2 rounded-2xl break-words",
          message.isFromMe
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted text-foreground rounded-bl-md"
        )}
      >
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </p>
      </div>

      {/* Timestamp */}
      {showTimestamp && (
        <span className="text-xs text-muted-foreground mt-1">
          {formatMessageTime(message.sentAt)}
        </span>
      )}
    </div>
  )
}

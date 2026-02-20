import { cn } from "../../lib/utils"
import type { InboxMessage } from "./message-types"
import { DeliveryStatus } from "../action-queue/message-response-card/message-bubble"
import { ReactionGroups } from "../reaction-groups"
import type React from "react"
import { formatTime } from "@cued/shared"

function decodeSlackEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

/**
 * Parse Slack-style markup in message content into React elements.
 * Handles:
 *  - `<URL|label>` → clickable link with label text
 *  - `<URL>` → clickable link showing truncated URL
 *  - `<@USER_ID>` / `<@USER_ID|name>` → @mention
 */
function parseSlackContent(text: string): React.ReactNode[] {
  const decodedText = decodeSlackEntities(text)
  const parts: React.ReactNode[] = []
  const regex = /<([^>]+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(decodedText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(decodedText.slice(lastIndex, match.index))
    }

    const inner = match[1]

    if (inner.startsWith("@")) {
      const pipeIdx = inner.indexOf("|")
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner
      parts.push(
        <span key={match.index} className="font-medium text-primary/80">
          {pipeIdx !== -1 ? `@${label}` : label}
        </span>
      )
    } else if (
      inner.startsWith("http://") ||
      inner.startsWith("https://") ||
      inner.startsWith("mailto:")
    ) {
      const pipeIdx = inner.indexOf("|")
      const url = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : undefined

      let displayText: string
      if (label) {
        displayText = label
      } else {
        try {
          const parsed = new URL(url)
          const path = parsed.pathname === "/" ? "" : parsed.pathname
          displayText = parsed.hostname + path
          if (displayText.length > 50) {
            displayText = displayText.slice(0, 47) + "..."
          }
        } catch {
          displayText = url.length > 50 ? url.slice(0, 47) + "..." : url
        }
      }

      parts.push(
        <a
          key={match.index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline"
        >
          {displayText}
        </a>
      )
    } else {
      parts.push(`<${inner}>`)
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < decodedText.length) {
    parts.push(decodedText.slice(lastIndex))
  }

  return parts
}

export type InboxMessageSpacing = "tight" | "normal" | "wide"

interface InboxMessageBubbleProps {
  message: InboxMessage
  showSenderName?: boolean
  spacing?: InboxMessageSpacing
  onContactClick?: (contactId: string) => void
}

const SPACING_CLASSES: Record<InboxMessageSpacing, string> = {
  tight: "mt-0.5",
  normal: "mt-2",
  wide: "mt-4",
}

export function InboxMessageBubble({
  message,
  showSenderName = false,
  spacing = "normal",
  onContactClick,
}: InboxMessageBubbleProps): React.ReactElement {
  const senderName = message.sender?.displayName
  const senderId = message.sender?._id
  const hasContent = message.content.trim().length > 0
  const hasReactions = (message.reactions?.length ?? 0) > 0
  const showStatusWithoutHover =
    message.isFromMe &&
    (message.status === "queued" ||
      message.status === "sending" ||
      message.status === "failed")
  const renderedContent =
    message.platform === "slack"
      ? parseSlackContent(message.content)
      : [message.content]

  return (
    <div
      className={cn(
        "group/msg flex flex-col",
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
            "max-w-[75%] px-4 py-2.5 rounded-[20px] wrap-break-words transition-all duration-200",
            message.isFromMe
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-foreground"
          )}
        >
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
            {renderedContent}
          </p>
        </div>
      )}

      {/* Reactions below the bubble */}
      {hasReactions && message.reactions && (
        <ReactionGroups
          reactions={message.reactions}
          className={message.isFromMe ? "justify-end" : "justify-start"}
        />
      )}

      {/* Timestamp/status line; always visible for queued/sending/failed outgoing messages */}
      <span
        className={cn(
          "text-[11px] text-muted-foreground/70 tabular-nums mt-1 px-1 flex items-center gap-1",
          showStatusWithoutHover
            ? "opacity-100 max-h-5"
            : "opacity-0 max-h-0 group-hover/msg:opacity-100 group-hover/msg:max-h-5",
          "transition-all duration-200 ease-out"
        )}
      >
        {formatTime(message.sentAt)}
        {message.isFromMe && message.status && (
          <>
            <span>·</span>
            <DeliveryStatus status={message.status} />
          </>
        )}
      </span>
    </div>
  )
}

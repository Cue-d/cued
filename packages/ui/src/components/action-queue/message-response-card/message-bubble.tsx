import * as React from "react"
import type { ReactionGroup } from "@cued/shared"
import { cn } from "../../../lib/utils"
import { ReactionGroups } from "../../reaction-groups"

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
 *  - `<#CHANNEL_ID|name>` → #channel
 */
function parseSlackContent(text: string): React.ReactNode[] {
  const decodedText = decodeSlackEntities(text)
  // Match <...> tokens in the text
  const parts: React.ReactNode[] = []
  const regex = /<([^>]+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(decodedText)) !== null) {
    // Push text before this match
    if (match.index > lastIndex) {
      parts.push(decodedText.slice(lastIndex, match.index))
    }

    const inner = match[1]

    if (inner.startsWith("@")) {
      // User mention: <@U123> or <@U123|name>
      const pipeIdx = inner.indexOf("|")
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner
      parts.push(
        <span key={match.index} className="font-medium text-primary/80">
          {pipeIdx !== -1 ? `@${label}` : label}
        </span>
      )
    } else if (inner.startsWith("#")) {
      // Channel mention: <#C123|channel-name>
      const pipeIdx = inner.indexOf("|")
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner
      parts.push(
        <span key={match.index} className="font-medium text-primary/80">
          {pipeIdx !== -1 ? `#${label}` : label}
        </span>
      )
    } else if (inner.startsWith("http://") || inner.startsWith("https://") || inner.startsWith("mailto:")) {
      // URL: <URL> or <URL|label>
      const pipeIdx = inner.indexOf("|")
      const url = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner
      const label = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : undefined

      // Show label if provided, otherwise show a truncated URL
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
      // Unknown bracket content — render as-is
      parts.push(`<${inner}>`)
    }

    lastIndex = match.index + match[0].length
  }

  // Push remaining text
  if (lastIndex < decodedText.length) {
    parts.push(decodedText.slice(lastIndex))
  }

  return parts
}

/** @deprecated Use ReactionGroups from ../../reaction-groups instead */
export function ReactionBadges({
  reactions,
}: {
  reactions: string[]
  isSent: boolean
}) {
  const displayReactions = reactions.slice(0, 3)
  return (
    <div className="flex gap-0.5 mt-1">
      {displayReactions.map((emoji, idx) => (
        <span key={idx} className="text-xs">{emoji}</span>
      ))}
    </div>
  )
}

/** Delivery status indicator */
export function DeliveryStatus({ status }: { status?: string | null }) {
  if (status === "queued") {
    return (
      <span className="opacity-60" title="Queued">
        Queued
      </span>
    )
  }
  if (status === "sending") {
    return (
      <span className="opacity-40 animate-pulse" title="Sending">
        Sending
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className="text-destructive" title="Failed to send">
        Failed
      </span>
    )
  }
  if (status === "read") {
    return (
      <span className="text-blue-400" title="Read">
        Read
      </span>
    )
  }
  if (status === "delivered") {
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

export type MessageSpacing = "tight" | "normal" | "wide"

export interface MessageBubbleProps {
  /** Unique message ID */
  id: string
  /** Message content */
  content?: string | null
  /** Whether message is from the user */
  isFromMe: boolean
  /** Message timestamp */
  sentAt: number
  /** Sender name (for received messages) */
  senderName?: string | null
  /** Contact ID of the sender */
  senderContactId?: string | null
  /** Delivery status */
  status?: string | null
  /** Reactions grouped by emoji */
  reactions?: ReactionGroup[] | null
  /** Whether to show sender name (for deduplication) */
  showSenderName?: boolean
  /** Spacing above this message */
  spacing?: MessageSpacing
  /** Platform the message is from — Slack content gets special markup parsing */
  platform?: string
  /** Called when a contact name is clicked */
  onContactClick?: (contactId: string) => void
}

const SPACING_CLASSES: Record<MessageSpacing, string> = {
  tight: "mt-0.5",
  normal: "mt-2",
  wide: "mt-4",
}

export function MessageBubble({
  content,
  isFromMe,
  sentAt,
  senderName,
  senderContactId,
  status,
  reactions,
  showSenderName = true,
  spacing = "normal",
  platform,
  onContactClick,
}: MessageBubbleProps) {
  const hasReactions = reactions && reactions.length > 0
  const hasText = typeof content === "string" && content.trim().length > 0

  const renderedContent = React.useMemo(
    () => (hasText && typeof content === "string" ? (platform === "slack" ? parseSlackContent(content) : [content]) : null),
    [hasText, content, platform]
  )

  return (
    <div
      className={cn(
        "flex flex-col w-full",
        isFromMe ? "items-end" : "items-start",
        SPACING_CLASSES[spacing]
      )}
    >
      {showSenderName && !isFromMe && senderName && (
        senderContactId && onContactClick ? (
          <button
            type="button"
            onClick={() => onContactClick(senderContactId)}
            className="text-xs font-medium opacity-70 mb-1 ml-1 hover:underline hover:opacity-100 transition-opacity cursor-pointer text-left"
          >
            {senderName}
          </button>
        ) : (
          <p className="text-xs font-medium opacity-70 mb-1 ml-1">
            {senderName}
          </p>
        )
      )}
      <div
        className={cn(
          "flex w-full",
          isFromMe ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            isFromMe
              ? "bg-primary/90 text-primary-foreground"
              : "bg-secondary text-foreground"
          )}
          style={{ maxWidth: "85%", width: "fit-content", overflowWrap: "anywhere" }}
        >
          {renderedContent ? (
            <p
              className="whitespace-pre-wrap select-text"
              style={{ overflowWrap: "anywhere" }}
              data-selectable="true"
            >
              {renderedContent}
            </p>
          ) : (
            <p className="whitespace-pre-wrap">
              [No text]
            </p>
          )}
        </div>
      </div>
      {hasReactions && (
        <ReactionGroups reactions={reactions!} className={isFromMe ? "justify-end" : "justify-start"} />
      )}
    </div>
  )
}

export default MessageBubble

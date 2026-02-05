"use client"

import * as React from "react"
import { formatTime } from "@cued/shared"
import { cn } from "../../../lib/utils"

/** Reaction badges component */
export function ReactionBadges({
  reactions,
  isSent,
}: {
  reactions: string[]
  isSent: boolean
}) {
  const displayReactions = reactions.slice(0, 3)
  return (
    <div
      className={cn(
        "absolute -top-3 flex gap-0.5 px-2 py-1 rounded-full bg-muted text-sm z-10 border",
        isSent ? "-left-3" : "-right-3"
      )}
    >
      {displayReactions.map((emoji, idx) => (
        <span key={idx}>{emoji}</span>
      ))}
    </div>
  )
}

/** Delivery status indicator */
export function DeliveryStatus({ status }: { status?: string | null }) {
  if (status === "failed") {
    return (
      <span className="text-destructive" title="Failed to send">
        !
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
  /** Delivery status */
  status?: string | null
  /** Reactions on the message */
  reactions?: string[] | null
  /** Whether to show sender name (for deduplication) */
  showSenderName?: boolean
  /** Spacing above this message */
  spacing?: MessageSpacing
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
  status,
  reactions,
  showSenderName = true,
  spacing = "normal",
}: MessageBubbleProps) {
  const hasReactions = reactions && reactions.length > 0
  const hasText = content && content.trim().length > 0

  return (
    <div
      className={cn(
        "flex flex-col w-full",
        isFromMe ? "items-end" : "items-start",
        hasReactions && "mb-2",
        SPACING_CLASSES[spacing]
      )}
    >
      {showSenderName && !isFromMe && senderName && (
        <p className="text-xs font-medium opacity-70 mb-1 ml-1">
          {senderName}
        </p>
      )}
      <div
        className={cn(
          "flex w-full",
          isFromMe ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "relative rounded-[8px] px-4 py-2 text-sm wrap-break-words",
            isFromMe
              ? "bg-primary text-primary-foreground"
              : "bg-background text-foreground shadow-minimal"
          )}
          style={{ maxWidth: "85%", width: "fit-content" }}
        >
          {hasReactions && (
            <ReactionBadges reactions={reactions!} isSent={isFromMe} />
          )}
          {hasText && content && (
            <p
              className="whitespace-pre-wrap wrap-break-words select-text"
              data-selectable="true"
            >
              {content}
            </p>
          )}
          {!hasText && (
            <p className="whitespace-pre-wrap wrap-break-words">
              [No text]
            </p>
          )}
          <p
            className={cn(
              "text-[10px] opacity-60 mt-1 flex items-center gap-1",
              isFromMe ? "justify-end" : "justify-start"
            )}
          >
            {formatTime(sentAt)}
            {isFromMe && (
              <>
                <span className="mx-0.5">·</span>
                <DeliveryStatus status={status} />
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

export default MessageBubble

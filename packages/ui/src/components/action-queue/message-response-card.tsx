"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { Textarea } from "../ui/textarea"

/** Message attachment with URL */
export interface MessageAttachment {
  filename: string | null
  mimeType: string | null
  url: string | null
  thumbnailUrl?: string | null
}

/** Message data shape for display */
export interface DisplayMessage {
  _id: string
  content: string | null
  sentAt: number
  isFromMe: boolean
  senderName: string | null
  status?: string | null
  reactions?: string[] | null
  attachments?: MessageAttachment[] | null
}

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
}

export interface MessageResponseCardRef {
  focusInput: () => void
}

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#"
  if (name.includes("@")) return name[0].toUpperCase()
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** Format timestamp to time string */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/** Format timestamp to relative time */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  return "Just now"
}

/** Reaction badges component */
function ReactionBadges({
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
        "absolute -top-3 flex gap-0.5 px-2 py-1 rounded-full bg-muted shadow-sm text-sm z-10 border",
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
function DeliveryStatus({ status }: { status?: string | null }) {
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

/** Attachment display component */
function AttachmentDisplay({
  attachments,
}: {
  attachments: MessageAttachment[]
}) {
  return (
    <div className="space-y-1 mb-1">
      {attachments.map((att, idx) => {
        const isImage = att.mimeType?.startsWith("image/")
        const url = att.thumbnailUrl || att.url

        if (isImage && url) {
          return (
            <img
              key={idx}
              src={url}
              alt={att.filename || "Image"}
              className="max-w-[200px] max-h-[200px] rounded-lg object-cover"
            />
          )
        }

        return (
          <div
            key={idx}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="truncate max-w-[150px]">
              {att.filename || "Attachment"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * MessageResponseCard component for action queue.
 * Displays message history and response textarea.
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
              sortedMessages.map((msg) => {
                const hasReactions = msg.reactions && msg.reactions.length > 0
                const hasAttachments =
                  msg.attachments && msg.attachments.length > 0
                const hasText =
                  msg.content &&
                  msg.content.trim().length > 0 &&
                  !(hasAttachments && msg.content.trim() === "[attachment]")

                return (
                  <div
                    key={msg._id}
                    className={cn(
                      "flex flex-col w-full",
                      msg.isFromMe ? "items-end" : "items-start",
                      hasReactions && "mb-2"
                    )}
                  >
                    {!msg.isFromMe && msg.senderName && (
                      <p className="text-xs font-medium opacity-70 mb-1 ml-1">
                        {msg.senderName}
                      </p>
                    )}
                    <div
                      className={cn(
                        "flex w-full",
                        msg.isFromMe ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "relative rounded-2xl px-4 py-2 text-sm break-words",
                          msg.isFromMe
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground"
                        )}
                        style={{ maxWidth: "85%", width: "fit-content" }}
                      >
                        {hasReactions && (
                          <ReactionBadges
                            reactions={msg.reactions!}
                            isSent={msg.isFromMe}
                          />
                        )}
                        {hasAttachments && (
                          <AttachmentDisplay attachments={msg.attachments!} />
                        )}
                        {hasText && msg.content && (
                          <p
                            className="whitespace-pre-wrap break-words select-text"
                            data-selectable="true"
                          >
                            {msg.content}
                          </p>
                        )}
                        {!hasText && !hasAttachments && (
                          <p className="whitespace-pre-wrap break-words">
                            [No text]
                          </p>
                        )}
                        <p
                          className={cn(
                            "text-[10px] opacity-60 mt-1 flex items-center gap-1",
                            msg.isFromMe ? "justify-end" : "justify-start"
                          )}
                        >
                          {formatTime(msg.sentAt)}
                          {msg.isFromMe && (
                            <>
                              <span className="mx-0.5">·</span>
                              <DeliveryStatus status={msg.status} />
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
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

      {/* Response Input */}
      <CardFooter className="p-4 bg-transparent" data-selectable="true">
        <Textarea
          ref={textareaRef}
          value={responseText}
          onChange={(e) => onResponseChange(e.target.value)}
          placeholder="Type your response... (swipe right to send)"
          className="min-h-[80px] max-h-[150px] resize-none bg-background w-full"
          onKeyDown={(e) => {
            // Prevent card swipe while typing
            e.stopPropagation()
          }}
        />
      </CardFooter>
    </Card>
  )
})

export default MessageResponseCard

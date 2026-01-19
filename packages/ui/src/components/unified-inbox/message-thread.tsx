"use client"

import { useEffect, useRef } from "react"
import { cn } from "../../lib/utils"
import { InboxMessageBubble } from "./message-bubble"
import type { InboxMessage } from "./message-types"
import type { InboxConversation } from "./types"
import { InboxConversationAvatar } from "./conversation-avatar"
import { InboxPlatformBadge } from "./platform-badge"

interface InboxMessageThreadProps {
  conversation: InboxConversation
  messages: InboxMessage[]
  loading?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  className?: string
}

function formatDateDivider(date: Date): string {
  const now = new Date()
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  )

  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "long" })
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: now.getFullYear() !== date.getFullYear() ? "numeric" : undefined,
  })
}

function groupMessagesByDate(
  messages: InboxMessage[]
): Map<string, InboxMessage[]> {
  const groups = new Map<string, InboxMessage[]>()

  // Messages come in DESC order from API, reverse to show oldest first
  const chronological = [...messages].reverse()

  for (const msg of chronological) {
    const dateKey = new Date(msg.sentAt).toDateString()
    const group = groups.get(dateKey)
    if (group) {
      group.push(msg)
    } else {
      groups.set(dateKey, [msg])
    }
  }

  return groups
}

function shouldShowTimestamp(
  message: InboxMessage,
  prevMessage: InboxMessage | undefined,
  isLast: boolean
): boolean {
  if (isLast) return true
  if (!prevMessage) return true

  // Show timestamp if sender changed
  if (message.isFromMe !== prevMessage.isFromMe) return true

  // Show timestamp if more than 5 minutes since previous message
  const timeDiff = Math.abs(message.sentAt - prevMessage.sentAt) / 1000 / 60
  return timeDiff > 5
}

function shouldShowSenderName(
  message: InboxMessage,
  prevMessage: InboxMessage | undefined,
  isGroup: boolean
): boolean {
  if (!isGroup) return false
  if (message.isFromMe) return false
  if (!prevMessage) return true
  if (prevMessage.isFromMe) return true

  // Show if sender changed
  return message.sender?._id !== prevMessage.sender?._id
}

export function InboxMessageThread({
  conversation,
  messages,
  loading = false,
  hasMore = false,
  onLoadMore,
  className,
}: InboxMessageThreadProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevConversationIdRef = useRef<string | null>(null)

  // Scroll to bottom when conversation changes
  useEffect(() => {
    if (conversation._id !== prevConversationIdRef.current) {
      prevConversationIdRef.current = conversation._id
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" })
    }
  }, [conversation._id])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0 && prevConversationIdRef.current === conversation._id) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages.length, conversation._id])

  const messagesByDate = groupMessagesByDate(messages)
  const isGroup = conversation.conversationType === "group" || conversation.conversationType === "channel"
  // For groups, prefer displayName (which includes participant fallback from server)
  const displayName = isGroup
    ? (conversation.displayName || "Group Chat")
    : (conversation.participants[0]?.displayName || "Unknown")

  return (
    <div className={cn("flex flex-col h-full min-h-0 bg-background", className)}>
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-5 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-3.5">
          <div className="transition-transform duration-200 hover:scale-105">
            <InboxConversationAvatar
              participants={conversation.participants}
              conversationType={conversation.conversationType}
              size="sm"
            />
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-foreground tracking-tight">{displayName}</span>
            {isGroup && conversation.participants.length > 1 && (
              <span className="text-xs text-muted-foreground">
                {conversation.participants.length} participants
              </span>
            )}
          </div>
        </div>
        <InboxPlatformBadge platform={conversation.platform} />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-5"
      >
        {/* Load more button */}
        {hasMore && (
          <div className="flex justify-center mb-6">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loading}
              className="text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors px-4 py-2 rounded-xl hover:bg-muted/50"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  Loading...
                </span>
              ) : (
                "Load older messages"
              )}
            </button>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground text-sm">No messages yet</p>
          </div>
        )}

        {/* Loading state */}
        {loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <p className="text-muted-foreground text-sm">Loading messages...</p>
          </div>
        )}

        {/* Message groups by date */}
        {Array.from(messagesByDate.entries()).map(([dateKey, dateMessages]) => (
          <div key={dateKey}>
            {/* Date divider */}
            <div className="flex items-center justify-center my-6">
              <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground/80 px-4 py-1.5 bg-muted/50 rounded-full border border-border/30">
                {formatDateDivider(new Date(dateKey))}
              </span>
            </div>

            {/* Messages for this date */}
            <div className="space-y-1.5">
              {dateMessages.map((message, idx) => {
                const prevMessage = idx > 0 ? dateMessages[idx - 1] : undefined
                const isLast = idx === dateMessages.length - 1

                return (
                  <InboxMessageBubble
                    key={message._id}
                    message={message}
                    showTimestamp={shouldShowTimestamp(message, prevMessage, isLast)}
                    showSenderName={shouldShowSenderName(message, prevMessage, isGroup)}
                  />
                )
              })}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>
    </div>
  )
}

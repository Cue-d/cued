"use client"

import { useEffect, useRef } from "react"
import { cn } from "../../lib/utils"
import { MessageBubble } from "./message-bubble"
import type { Message } from "./message-types"
import type { Conversation } from "./types"
import { ConversationAvatar } from "./conversation-avatar"
import { PlatformBadge } from "./platform-badge"

interface MessageThreadProps {
  conversation: Conversation
  messages: Message[]
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
  messages: Message[]
): Map<string, Message[]> {
  const groups = new Map<string, Message[]>()

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
  message: Message,
  prevMessage: Message | undefined,
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
  message: Message,
  prevMessage: Message | undefined,
  isGroup: boolean
): boolean {
  if (!isGroup) return false
  if (message.isFromMe) return false
  if (!prevMessage) return true
  if (prevMessage.isFromMe) return true

  // Show if sender changed
  return message.sender?._id !== prevMessage.sender?._id
}

export function MessageThread({
  conversation,
  messages,
  loading = false,
  hasMore = false,
  onLoadMore,
  className,
}: MessageThreadProps): React.ReactElement {
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
  const displayName =
    conversation.participants[0]?.displayName ||
    conversation.platformConversationId

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b shrink-0">
        <div className="flex items-center gap-3">
          <ConversationAvatar
            participants={conversation.participants}
            conversationType={conversation.conversationType}
            size="sm"
          />
          <div className="flex flex-col">
            <span className="font-medium text-foreground">{displayName}</span>
            {isGroup && conversation.participants.length > 1 && (
              <span className="text-xs text-muted-foreground">
                {conversation.participants.length} participants
              </span>
            )}
          </div>
        </div>
        <PlatformBadge platform={conversation.platform} />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4"
      >
        {/* Load more button */}
        {hasMore && (
          <div className="flex justify-center mb-4">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loading}
              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {loading ? "Loading..." : "Load older messages"}
            </button>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">No messages</p>
          </div>
        )}

        {/* Loading state */}
        {loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">Loading messages...</p>
          </div>
        )}

        {/* Message groups by date */}
        {Array.from(messagesByDate.entries()).map(([dateKey, dateMessages]) => (
          <div key={dateKey}>
            {/* Date divider */}
            <div className="flex items-center justify-center my-4">
              <span className="text-xs text-muted-foreground px-3 py-1 bg-muted rounded-full">
                {formatDateDivider(new Date(dateKey))}
              </span>
            </div>

            {/* Messages for this date */}
            <div className="space-y-1">
              {dateMessages.map((message, idx) => {
                const prevMessage = idx > 0 ? dateMessages[idx - 1] : undefined
                const isLast = idx === dateMessages.length - 1

                return (
                  <MessageBubble
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

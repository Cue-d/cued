import type React from "react"
import { cn } from "../../lib/utils"
import { ConversationAvatar } from "./conversation-avatar"
import { PlatformBadge } from "./platform-badge"
import type { Conversation } from "./types"

interface ConversationItemProps {
  conversation: Conversation
  isSelected: boolean
  onClick: () => void
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return ""

  const date = new Date(timestamp)
  const diffDays = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  }
  if (diffDays === 1) {
    return "Yesterday"
  }
  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" })
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getConversationName(conversation: Conversation): string {
  const { participants } = conversation
  if (participants.length === 0) return "Unknown"
  if (participants.length === 1) return participants[0].displayName

  return participants
    .slice(0, 2)
    .map((p) => p.displayName.split(" ")[0])
    .join(", ")
}

export function ConversationItem({
  conversation,
  isSelected,
  onClick,
}: ConversationItemProps): React.ReactElement {
  const name = getConversationName(conversation)
  const hasUnread = conversation.unreadCount > 0

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left relative",
        isSelected
          ? "bg-primary text-primary-foreground"
          : "hover:bg-muted"
      )}
    >
      {/* Unread indicator */}
      {hasUnread && !isSelected && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
      )}

      <ConversationAvatar
        participants={conversation.participants}
        conversationType={conversation.conversationType}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={cn(
                "font-medium truncate text-[15px]",
                isSelected ? "text-primary-foreground" : "text-foreground"
              )}
            >
              {name}
            </span>
            <PlatformBadge platform={conversation.platform} />
          </div>
          <span
            className={cn(
              "text-xs shrink-0",
              isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
            )}
          >
            {formatTimestamp(conversation.lastMessageAt)}
          </span>
        </div>
        <p
          className={cn(
            "text-[13px] truncate mt-0.5",
            isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          {conversation.lastMessageText || "No messages"}
        </p>
      </div>
    </button>
  )
}

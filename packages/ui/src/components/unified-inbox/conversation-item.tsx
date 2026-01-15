import type React from "react"
import { cn } from "../../lib/utils"
import { InboxConversationAvatar } from "./conversation-avatar"
import { InboxPlatformBadge } from "./platform-badge"
import type { InboxConversation } from "./types"

interface InboxConversationItemProps {
  conversation: InboxConversation
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

function getConversationName(conversation: InboxConversation): string {
  const { participants } = conversation
  if (participants.length === 0) return "Unknown"
  if (participants.length === 1) return participants[0].displayName

  return participants
    .slice(0, 2)
    .map((p) => p.displayName.split(" ")[0])
    .join(", ")
}

export function InboxConversationItem({
  conversation,
  isSelected,
  onClick,
}: InboxConversationItemProps): React.ReactElement {
  const name = getConversationName(conversation)
  const hasUnread = conversation.unreadCount > 0

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left relative",
        "transition-all duration-200 ease-out",
        isSelected
          ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
          : "hover:bg-muted/80 active:scale-[0.98]"
      )}
    >
      {/* Unread indicator */}
      {hasUnread && !isSelected && (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 w-2 h-2 bg-primary rounded-full shadow-sm shadow-primary/50 animate-pulse" />
      )}

      <div className={cn(
        "transition-transform duration-200",
        !isSelected && "group-hover:scale-105"
      )}>
        <InboxConversationAvatar
          participants={conversation.participants}
          conversationType={conversation.conversationType}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "font-semibold truncate text-[15px] tracking-tight",
                isSelected ? "text-primary-foreground" : "text-foreground"
              )}
            >
              {name}
            </span>
            <InboxPlatformBadge platform={conversation.platform} />
          </div>
          <span
            className={cn(
              "text-[11px] font-medium shrink-0 tabular-nums",
              isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
            )}
          >
            {formatTimestamp(conversation.lastMessageAt)}
          </span>
        </div>
        <p
          className={cn(
            "text-[13px] truncate mt-0.5 leading-relaxed",
            isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          {conversation.lastMessageText || "No messages"}
        </p>
      </div>
    </button>
  )
}

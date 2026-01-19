import type React from "react"
import { getInitials } from "@prm/shared"
import { cn } from "../../lib/utils"
import type { InboxParticipant, InboxConversationType } from "./types"

interface InboxConversationAvatarProps {
  participants: InboxParticipant[]
  conversationType: InboxConversationType
  size?: "sm" | "md" | "lg"
  className?: string
}

const sizeClasses = {
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-12 h-12 text-base",
}

const bgColors = [
  "bg-slate-500",
  "bg-zinc-500",
  "bg-stone-500",
  "bg-gray-500",
  "bg-neutral-500",
  "bg-slate-600",
  "bg-zinc-600",
  "bg-stone-600",
]

function getColorForName(name: string): string {
  const code = name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return bgColors[code % bgColors.length]
}

function SingleAvatar({ name, className }: { name: string; className?: string }): React.ReactElement {
  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center text-white font-medium shrink-0",
        getColorForName(name),
        className
      )}
    >
      {getInitials(name)}
    </div>
  )
}

export function InboxConversationAvatar({
  participants,
  conversationType,
  size = "md",
  className,
}: InboxConversationAvatarProps): React.ReactElement {
  const isGroup = conversationType === "group" || conversationType === "channel"
  const [first, second] = participants
  const displayName = first?.displayName || "?"

  if (isGroup && participants.length >= 2) {
    return (
      <div className={cn("relative shrink-0", sizeClasses[size], className)}>
        <SingleAvatar
          name={first?.displayName || "?"}
          className="absolute top-0 left-0 w-6 h-6 border-2 border-background text-[10px]"
        />
        <SingleAvatar
          name={second?.displayName || "?"}
          className="absolute bottom-0 right-0 w-6 h-6 border-2 border-background text-[10px]"
        />
      </div>
    )
  }

  return <SingleAvatar name={displayName} className={cn(sizeClasses[size], className)} />
}

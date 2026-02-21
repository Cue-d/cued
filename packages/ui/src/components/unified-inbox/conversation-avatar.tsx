import { getInitials } from "@cued/shared"
import { cn } from "../../lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import type { InboxParticipant, InboxConversationType } from "./types"
import type React from "react"

interface InboxConversationAvatarProps {
  participants: InboxParticipant[]
  conversationType: InboxConversationType
  size?: "sm" | "md" | "lg"
  className?: string
}

const sizeClasses = {
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-12 h-12",
}

const textSizeClasses = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
}

type ConversationAvatarSize = NonNullable<InboxConversationAvatarProps["size"]>

const avatarSizes: Record<ConversationAvatarSize, "default" | "sm" | "lg"> = {
  sm: "sm",
  md: "default",
  lg: "lg",
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

function SingleAvatar({
  participant,
  size = "md",
  className,
  textClassName,
}: {
  participant?: InboxParticipant
  size?: "sm" | "md" | "lg"
  className?: string
  textClassName?: string
}): React.ReactElement {
  const displayName = participant?.displayName || "?"

  return (
    <Avatar className={className} size={avatarSizes[size]}>
      {participant?.avatarUrl ? (
        <AvatarImage src={participant.avatarUrl} alt={displayName} />
      ) : null}
      <AvatarFallback
        className={cn(
          "text-white font-medium",
          getColorForName(displayName),
          textClassName ?? textSizeClasses[size]
        )}
      >
        {getInitials(displayName)}
      </AvatarFallback>
    </Avatar>
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

  if (isGroup && participants.length >= 2) {
    return (
      <div className={cn("relative shrink-0", sizeClasses[size], className)}>
        <SingleAvatar
          participant={first}
          size="sm"
          className="absolute top-0 left-0 w-6 h-6 border-2 border-background"
          textClassName="text-[10px]"
        />
        <SingleAvatar
          participant={second}
          size="sm"
          className="absolute bottom-0 right-0 w-6 h-6 border-2 border-background"
          textClassName="text-[10px]"
        />
      </div>
    )
  }

  return (
    <SingleAvatar
      participant={first}
      size={size}
      className={cn(sizeClasses[size], className)}
    />
  )
}

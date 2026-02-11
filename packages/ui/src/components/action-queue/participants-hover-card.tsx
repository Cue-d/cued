import * as React from "react"
import { motion } from "motion/react"
import { getInitials, PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared"
import { cn } from "../../lib/utils"
import { PlatformIcon } from "../platform-icons"
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "../ui/hover-card"

export interface Participant {
  _id: string
  displayName: string
  platforms: string[]
}

interface ParticipantsHoverCardProps {
  participants: Participant[]
  onContactClick?: (contactId: string) => void
  children: React.ReactNode
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
  const code = name
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return bgColors[code % bgColors.length]
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.025, delayChildren: 0.01 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: "easeOut" as const },
  },
}

export function ParticipantsHoverCard({
  participants,
  onContactClick,
  children,
}: ParticipantsHoverCardProps) {
  if (participants.length === 0) {
    return <>{children}</>
  }

  return (
    <HoverCard>
      <HoverCardTrigger className="cursor-pointer">
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="center"
        sideOffset={8}
        className="w-72 p-2"
      >
        <p className="text-xs font-medium text-muted-foreground px-2 pb-1.5">
          {participants.length} participant{participants.length !== 1 ? "s" : ""}
        </p>
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-0.5"
        >
          {participants.map((participant) => (
            <motion.button
              key={participant._id}
              variants={itemVariants}
              type="button"
              onClick={() => onContactClick?.(participant._id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                onContactClick
                  ? "hover:bg-foreground/[0.05] cursor-pointer"
                  : "cursor-default"
              )}
            >
              <div
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-medium shrink-0",
                  getColorForName(participant.displayName)
                )}
              >
                {getInitials(participant.displayName)}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">
                  {participant.displayName}
                </span>
              </div>
              <div className="flex gap-1 shrink-0">
                {participant.platforms.map((platform) => {
                  const config =
                    PLATFORM_CONFIG[platform as ActionPlatform]
                  if (!config) return null
                  return (
                    <span
                      key={platform}
                      className={cn(
                        "inline-flex items-center justify-center w-5 h-5 rounded",
                        config.bgClass
                      )}
                      title={config.label}
                    >
                      <PlatformIcon
                        platform={platform as ActionPlatform}
                        className="w-3 h-3"
                      />
                    </span>
                  )
                })}
              </div>
            </motion.button>
          ))}
        </motion.div>
      </HoverCardContent>
    </HoverCard>
  )
}

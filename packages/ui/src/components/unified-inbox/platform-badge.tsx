import type React from "react"
import { cn } from "../../lib/utils"
import type { InboxPlatform } from "./types"

interface InboxPlatformBadgeProps {
  platform: InboxPlatform
  className?: string
}

const platformConfig: Record<InboxPlatform, { label: string; letter: string; colorClass: string }> = {
  imessage: { label: "iMessage", letter: "i", colorClass: "bg-green-500 text-white" },
  gmail: { label: "Gmail", letter: "G", colorClass: "bg-red-500 text-white" },
  slack: { label: "Slack", letter: "S", colorClass: "bg-purple-500 text-white" },
}

export function InboxPlatformBadge({ platform, className }: InboxPlatformBadgeProps): React.ReactElement {
  const config = platformConfig[platform]

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium shrink-0",
        config.colorClass,
        className
      )}
      title={config.label}
    >
      {config.letter}
    </span>
  )
}

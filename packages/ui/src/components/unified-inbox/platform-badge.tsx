import type React from "react"
import { cn } from "../../lib/utils"
import type { Platform } from "./types"

interface PlatformBadgeProps {
  platform: Platform
  className?: string
}

const platformConfig: Record<Platform, { label: string; letter: string; colorClass: string }> = {
  imessage: { label: "iMessage", letter: "i", colorClass: "bg-green-500 text-white" },
  gmail: { label: "Gmail", letter: "G", colorClass: "bg-red-500 text-white" },
  slack: { label: "Slack", letter: "S", colorClass: "bg-purple-500 text-white" },
}

export function PlatformBadge({ platform, className }: PlatformBadgeProps): React.ReactElement {
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

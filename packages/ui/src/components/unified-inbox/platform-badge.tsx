import type React from "react"
import { PLATFORM_CONFIG } from "@prm/shared"
import { cn } from "../../lib/utils"
import type { InboxPlatform } from "./types"

interface InboxPlatformBadgeProps {
  platform: InboxPlatform
  className?: string
}

export function InboxPlatformBadge({ platform, className }: InboxPlatformBadgeProps): React.ReactElement {
  const config = PLATFORM_CONFIG[platform]

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium shrink-0",
        config.bgClass,
        className
      )}
      title={config.label}
    >
      {config.letter}
    </span>
  )
}

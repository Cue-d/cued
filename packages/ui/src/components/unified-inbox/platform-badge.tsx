import { PLATFORM_CONFIG } from "@cued/shared"
import { cn } from "../../lib/utils"
import { PlatformIcon } from "../platform-icons"
import type { InboxPlatform } from "./types"
import type React from "react"

interface InboxPlatformBadgeProps {
  platform: InboxPlatform
  className?: string
}

export function InboxPlatformBadge({ platform, className }: InboxPlatformBadgeProps): React.ReactElement {
  const config = PLATFORM_CONFIG[platform]

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center w-4 h-4 rounded-full shrink-0",
        config.bgClass,
        className
      )}
      title={config.label}
    >
      <PlatformIcon platform={platform} className="w-2.5 h-2.5" />
    </span>
  )
}

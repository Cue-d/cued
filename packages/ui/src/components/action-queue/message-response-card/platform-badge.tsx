"use client"

import * as React from "react"
import { MessageSquare, Mail, Hash, ChevronDown } from "lucide-react"
import { PLATFORM_CONFIG, type ActionPlatform } from "@prm/shared"
import { cn } from "../../../lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu"

/** Platform icons (platform-specific, not in shared config) */
export const PLATFORM_ICONS: Record<ActionPlatform, React.ReactNode> = {
  imessage: <MessageSquare className="w-3.5 h-3.5" />,
  gmail: <Mail className="w-3.5 h-3.5" />,
  slack: <Hash className="w-3.5 h-3.5" />,
}

export interface PlatformBadgeProps {
  /** Current platform */
  platform: ActionPlatform
  /** Available platforms (enables dropdown if >1) */
  availablePlatforms?: ActionPlatform[]
  /** Called when platform changes */
  onPlatformChange?: (platform: ActionPlatform) => void
}

/**
 * PlatformBadge component - displays current platform with optional dropdown selector.
 * Shows as a simple badge when only one platform is available.
 */
export function PlatformBadge({
  platform,
  availablePlatforms,
  onPlatformChange,
}: PlatformBadgeProps) {
  // Show dropdown when multiple platforms available and handler provided
  if (availablePlatforms && availablePlatforms.length > 1 && onPlatformChange) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/60 hover:bg-muted text-sm transition-colors">
          <span className={PLATFORM_CONFIG[platform].textClass}>
            {PLATFORM_ICONS[platform]}
          </span>
          <span className="text-xs font-medium">{PLATFORM_CONFIG[platform].label}</span>
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {availablePlatforms.map((p) => (
            <DropdownMenuItem
              key={p}
              onClick={() => onPlatformChange(p)}
              className={cn(
                "flex items-center gap-2",
                p === platform && "bg-muted"
              )}
            >
              <span className={PLATFORM_CONFIG[p].textClass}>
                {PLATFORM_ICONS[p]}
              </span>
              <span>{PLATFORM_CONFIG[p].label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Simple badge (single platform)
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/60 text-sm">
      <span className={PLATFORM_CONFIG[platform].textClass}>
        {PLATFORM_ICONS[platform]}
      </span>
      <span className="text-xs font-medium">{PLATFORM_CONFIG[platform].label}</span>
    </div>
  )
}

export default PlatformBadge

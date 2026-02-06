import { ExternalLink } from "lucide-react"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip"
import type { OpenInAppConfig } from "../../actions/types"

interface OpenInAppButtonProps {
  config: OpenInAppConfig
  /** "sm" for resolve-contact cards, "md" (default) for message/contact cards */
  size?: "sm" | "md"
  /** Tooltip text when enabled (default: "Open") */
  tooltip?: string
}

export function OpenInAppButton({ config, size = "md", tooltip = "Open" }: OpenInAppButtonProps) {
  if (!config.label) return null

  const iconSize = size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3"
  const padding = size === "sm" ? "px-2 py-1" : "px-2.5 py-1.5"
  const textSize = size === "sm" ? "text-[11px]" : "text-xs"

  if (config.disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span
            role="button"
            aria-disabled="true"
            className={cn(
              "flex items-center gap-1 rounded-md font-medium bg-muted/40 text-muted-foreground cursor-not-allowed opacity-50",
              padding, textSize,
              size === "md" && "gap-1.5 rounded-lg"
            )}
          />}
        >
          {config.icon}
          {config.label}
          <ExternalLink className={iconSize} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {config.disabledReason}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<button
          type="button"
          onClick={config.onOpenInApp}
          className={cn(
            "flex items-center gap-1 rounded-md font-medium bg-muted/60 hover:bg-muted text-foreground/80 hover:text-foreground transition-colors cursor-pointer",
            padding, textSize,
            size === "md" && "gap-1.5 rounded-lg"
          )}
        />}
      >
        {config.icon}
        {config.label}
        <ExternalLink className={cn(iconSize, "text-muted-foreground")} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

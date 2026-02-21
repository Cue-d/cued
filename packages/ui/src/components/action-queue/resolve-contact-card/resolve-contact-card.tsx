import * as React from "react"
import { ExternalLink, Mail, Phone } from "lucide-react"
import { getInitials, PLATFORM_CONFIG, type ActionPlatform, type ContactHandle } from "@cued/shared"
import { cn } from "../../../lib/utils"
import { Avatar, AvatarFallback } from "../../ui/avatar"
import { PlatformIcon } from "../../platform-icons"
import { formatSource, type MergeSource } from "./source-badge"

export interface MergeHandle extends ContactHandle {
  /** Human-readable label to show instead of raw value */
  displayLabel?: string
  /** Contact name this handle came from */
  sourceContactName?: string
  /** Deep link URL for opening this handle in its platform app */
  deeplinkUrl?: string
}

export interface ResolveContactCardProps {
  /** Shared display name */
  name: string
  /** Merged list of handles across both contacts */
  handles: MergeHandle[]
  /** Confidence score 0-1 */
  confidence: number
  /** How the match was detected */
  source: MergeSource
  /** AI reasoning for the match */
  reasoning?: string | null
  /** Optional class name */
  className?: string
  /** Called when a deeplink is clicked */
  onLinkClick?: (url: string) => void
}

function getHeaderText(confidence: number): string {
  if (confidence >= 0.9) return "Link these accounts?"
  if (confidence >= 0.7) return "Same person?"
  return "Possible match"
}

/** Map handle type to a platform key for icon/color lookup */
function handlePlatform(handle: MergeHandle): ActionPlatform | null {
  // Use the handle's platform field directly if it maps to a known platform
  if (handle.platform && handle.platform in PLATFORM_CONFIG) {
    return handle.platform as ActionPlatform
  }
  // Fallback: infer from handle type
  switch (handle.type) {
    case "slack_id":
      return "slack"
    case "linkedin_handle":
    case "linkedin_urn":
      return "linkedin"
    case "twitter_handle":
      return "twitter"
    default:
      return null
  }
}

/** Render either a branded platform icon or a generic icon for phone/email */
function HandleRowIcon({ handle }: { handle: MergeHandle }) {
  const platform = handlePlatform(handle)
  if (platform) {
    const config = PLATFORM_CONFIG[platform]
    return (
      <span className={config.textClass}>
        <PlatformIcon platform={platform} className="w-4 h-4" />
      </span>
    )
  }
  // Generic fallbacks for non-platform handles
  if (handle.type === "phone") return <Phone className="w-4 h-4 text-muted-foreground" />
  if (handle.type === "email") return <Mail className="w-4 h-4 text-muted-foreground" />
  return null
}

function HandleRow({ handle, onLinkClick }: { handle: MergeHandle; onLinkClick?: (url: string) => void }) {
  const platform = handlePlatform(handle)
  const config = platform ? PLATFORM_CONFIG[platform] : null
  const label = handle.displayLabel ?? handle.value

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg bg-muted/50">
      <HandleRowIcon handle={handle} />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {handle.sourceContactName ? (
          <span className="block truncate text-xs text-muted-foreground">
            {handle.sourceContactName}
          </span>
        ) : null}
      </span>
      {config ? (
        <span className="text-xs text-muted-foreground">{config.label}</span>
      ) : null}
      {handle.deeplinkUrl && onLinkClick ? (
        <button
          type="button"
          onClick={() => onLinkClick(handle.deeplinkUrl!)}
          className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label={`Open in ${config?.label ?? "app"}`}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function ResolveContactCard({
  name,
  handles,
  confidence,
  source,
  reasoning,
  className,
  onLinkClick,
}: ResolveContactCardProps) {
  const confidencePercent = Math.round(confidence * 100)
  const initials = getInitials(name)

  return (
    <div className={cn("w-full h-full flex flex-col items-center justify-center px-6", className)}>
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* Avatar + Name */}
        <div className="flex flex-col items-center gap-3">
          <Avatar size="lg" className="size-14">
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="text-center">
            <h4 className="font-semibold text-base">{name}</h4>
            <p className="text-sm text-muted-foreground mt-1">
              {getHeaderText(confidence)}
            </p>
          </div>
        </div>

        {/* Handle list */}
        {handles.length > 0 ? (
          <div className="w-full space-y-1.5">
            {handles.map((handle, i) => (
              <HandleRow
                key={`${handle.type}-${handle.value}-${i}`}
                handle={handle}
                onLinkClick={onLinkClick}
              />
            ))}
          </div>
        ) : null}

        {/* Match info */}
        <p className="text-xs text-muted-foreground">
          {formatSource(source)} · {confidencePercent}% confidence
        </p>

        {reasoning && confidence < 0.7 ? (
          <p className="text-xs text-muted-foreground text-center line-clamp-2 -mt-4">
            {reasoning}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default ResolveContactCard

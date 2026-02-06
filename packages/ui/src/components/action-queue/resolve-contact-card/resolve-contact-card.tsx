import * as React from "react"
import { ArrowLeftRight } from "lucide-react"
import { type ContactHandle } from "@cued/shared"
import { type OpenInAppConfig } from "../../../actions/types"
import { cn } from "../../../lib/utils"
import { Badge } from "../../ui/badge"
import { Card, CardContent, CardHeader } from "../../ui/card"
import { OpenInAppButton } from "../open-in-app-button"
import { ContactPanel } from "./contact-panel"
import { SourceBadge, type MergeSource } from "./source-badge"

export interface ResolveContactCardProps {
  /** Primary contact (will be kept) */
  contact1: {
    name: string
    company?: string | null
    handles: ContactHandle[]
  }
  /** Secondary contact (will be merged into primary) */
  contact2: {
    name: string
    company?: string | null
    handles: ContactHandle[]
  }
  /** Confidence score 0-1 */
  confidence: number
  /** How the match was detected */
  source: MergeSource
  /** AI reasoning for the match */
  reasoning?: string | null
  /** Optional class name */
  className?: string
  /** Open-in-app config for contact 1 */
  contact1OpenInApp?: OpenInAppConfig | null
  /** Open-in-app config for contact 2 */
  contact2OpenInApp?: OpenInAppConfig | null
}

/**
 * ResolveContactCard for action queue.
 * Shows two contacts side-by-side for merge review.
 * Designed for swipe interactions (no buttons).
 */
export function ResolveContactCard({
  contact1,
  contact2,
  confidence,
  source,
  reasoning,
  className,
  contact1OpenInApp,
  contact2OpenInApp,
}: ResolveContactCardProps) {
  const confidencePercent = Math.round(confidence * 100)

  return (
    <Card className={cn("w-full h-full flex flex-col bg-transparent", className)}>
      <CardHeader className="pb-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Possible duplicate</span>
            <SourceBadge source={source} />
          </div>
          <Badge variant="secondary" className="text-xs">
            {confidencePercent}% match
          </Badge>
        </div>
        {reasoning ? (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {reasoning}
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="pt-2 flex-1 flex flex-col">
        {/* Side-by-side comparison */}
        <div className="flex gap-4 items-start flex-1">
          <div className="flex-1 min-w-0">
            <ContactPanel
              name={contact1.name}
              company={contact1.company}
              handles={contact1.handles}
            />
            {contact1OpenInApp?.label && (
              <div className="mt-2">
                <OpenInAppButton size="sm" config={contact1OpenInApp} />
              </div>
            )}
          </div>

          <div className="flex flex-col items-center justify-center py-4 flex-shrink-0">
            <ArrowLeftRight className="w-4 h-4 text-muted-foreground" />
          </div>

          <div className="flex-1 min-w-0">
            <ContactPanel
              name={contact2.name}
              company={contact2.company}
              handles={contact2.handles}
            />
            {contact2OpenInApp?.label && (
              <div className="mt-2">
                <OpenInAppButton size="sm" config={contact2OpenInApp} />
              </div>
            )}
          </div>
        </div>

        {/* Swipe hints */}
        <div className="flex justify-between items-center pt-4 mt-auto border-t text-xs text-muted-foreground">
          <span>← Different people</span>
          <span>↑ Snooze</span>
          <span>Merge →</span>
        </div>
      </CardContent>
    </Card>
  )
}

export default ResolveContactCard

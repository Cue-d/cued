import { cn } from "../../../lib/utils"
import { Badge } from "../../ui/badge"

export type MergeSource =
  | "email_match"
  | "phone_match"
  | "exact_name_match"
  | "fuzzy_name_match"
  | "llm_fuzzy_match"

/** Get source badge color */
function getSourceColor(source: MergeSource): string {
  switch (source) {
    case "email_match":
      return "bg-red-500/10 text-red-600 border-red-200"
    case "phone_match":
      return "bg-green-500/10 text-green-600 border-green-200"
    case "exact_name_match":
      return "bg-blue-500/10 text-blue-600 border-blue-200"
    case "fuzzy_name_match":
      return "bg-amber-500/10 text-amber-600 border-amber-200"
    case "llm_fuzzy_match":
      return "bg-purple-500/10 text-purple-600 border-purple-200"
  }
}

/** Format source for display */
function formatSource(source: MergeSource): string {
  return source.replace(/_/g, " ")
}

export interface SourceBadgeProps {
  source: MergeSource
  className?: string
}

export function SourceBadge({ source, className }: SourceBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs capitalize", getSourceColor(source), className)}
    >
      {formatSource(source)}
    </Badge>
  )
}

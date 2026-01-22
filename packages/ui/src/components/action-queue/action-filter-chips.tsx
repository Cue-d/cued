import * as React from "react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"

/** Filter group definitions */
export const ACTION_FILTER_GROUPS = {
  all: {
    label: "All",
    types: null, // null means no filter
  },
  messages: {
    label: "Messages",
    types: ["respond", "send_message"],
  },
  contacts: {
    label: "Contacts",
    types: ["resolve_contact", "new_connection"],
  },
  followups: {
    label: "Follow-ups",
    types: ["follow_up", "eod_contact"],
  },
} as const

export type FilterGroup = keyof typeof ACTION_FILTER_GROUPS

export interface ActionFilterChipsProps {
  /** Counts by action type { respond: 5, resolve_contact: 3, ... } */
  counts: Record<string, number>
  /** Total count of all actions */
  total: number
  /** Currently active filter group */
  activeFilter: FilterGroup
  /** Called when filter changes */
  onFilterChange: (filter: FilterGroup) => void
  /** Stack chips vertically */
  vertical?: boolean
  /** Optional class name */
  className?: string
}

/** Calculate count for a filter group */
function getGroupCount(
  group: FilterGroup,
  counts: Record<string, number>,
  total: number
): number {
  const config = ACTION_FILTER_GROUPS[group]
  if (config.types === null) {
    return total
  }
  return config.types.reduce((sum, type) => sum + (counts[type] ?? 0), 0)
}

export function ActionFilterChips({
  counts,
  total,
  activeFilter,
  onFilterChange,
  vertical,
  className,
}: ActionFilterChipsProps) {
  const groups = Object.entries(ACTION_FILTER_GROUPS) as [
    FilterGroup,
    (typeof ACTION_FILTER_GROUPS)[FilterGroup]
  ][]

  return (
    <div className={cn("flex gap-2", vertical ? "flex-col" : "flex-wrap", className)}>
      {groups.map(([key, config]) => {
        const count = getGroupCount(key, counts, total)
        const isActive = activeFilter === key

        // Don't show groups with 0 items (except "all")
        if (count === 0 && key !== "all") {
          return null
        }

        return (
          <Button
            key={key}
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onFilterChange(key)}
            className={cn(
              "text-xs justify-start",
              isActive && "bg-secondary"
            )}
          >
            {config.label}
            <span className="ml-1 text-muted-foreground">({count})</span>
          </Button>
        )
      })}
    </div>
  )
}

export default ActionFilterChips

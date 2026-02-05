import { ACTION_FILTER_GROUPS, getGroupCount, type FilterGroup } from "./filter-utils"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"

export { ACTION_FILTER_GROUPS, type FilterGroup }

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

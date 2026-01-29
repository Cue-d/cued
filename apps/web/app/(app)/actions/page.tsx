"use client"

import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@prm/convex"
import { type EnrichedAction } from "@prm/shared"
import {
  CardStack,
  ActionFilterChips,
  ACTION_FILTER_GROUPS,
  type SwipeDirection,
  type FilterGroup,
  type ActionContext,
} from "@prm/ui"
import { Button, Skeleton } from "@prm/ui"
import type { Id } from "@prm/convex"

/** Map action with context to CardStack ActionItem format */
interface ActionWithId {
  id: string
  type: string
  action: EnrichedAction
  [key: string]: unknown
}

const EMPTY_ACTIONS: EnrichedAction[] = []
const EMPTY_COUNTS: Record<string, number> = {}

export default function ActionsPage() {
  // Filter state
  const [activeFilter, setActiveFilter] = React.useState<FilterGroup>("all")

  // Get action types to filter by based on active filter group
  const filterConfig = ACTION_FILTER_GROUPS[activeFilter]
  const filterTypes = filterConfig.types as readonly string[] | null

  // Fetch pending actions list (no server-side type filter since groups have multiple types)
  const actionsResult = useQuery(api.actions.getPendingActions, { limit: 50 })
  const countResult = useQuery(api.actions.getPendingActionCount, {})
  const countsResult = useQuery(api.actions.getActionCountsByType, {})

  // Filter actions client-side based on active filter group
  const rawActions = actionsResult?.actions ?? EMPTY_ACTIONS
  const actions = React.useMemo(() => {
    if (!filterTypes) return rawActions // "all" filter
    return rawActions.filter((a) => filterTypes.includes(a.type))
  }, [rawActions, filterTypes])

  const counts = countsResult?.counts ?? EMPTY_COUNTS
  const totalFromCounts = countsResult?.total ?? 0
  const totalCount = countResult?.count ?? 0
  const loading = actionsResult === undefined

  // Get top action ID for context fetch
  const topActionId = actions.length > 0 ? (actions[0]._id as Id<"actions">) : null

  // Fetch full context for top action only
  const contextResult = useQuery(
    api.actions.getActionWithContext,
    topActionId ? { actionId: topActionId, messageLimit: 15 } : "skip"
  )

  // Mutations
  const swipeAction = useMutation(api.actions.swipeAction)
  const triggerScan = useMutation(api.actionQueue.triggerScanForUnanswered)

  // Scan state
  const [scanning, setScanning] = React.useState(false)

  const handleScan = React.useCallback(async () => {
    setScanning(true)
    try {
      await triggerScan({})
    } catch (error) {
      console.error("Failed to trigger scan:", error)
    } finally {
      setScanning(false)
    }
  }, [triggerScan])

  // Handle swipe
  const handleSwipe = React.useCallback(
    async (
      actionId: string,
      direction: SwipeDirection,
      responseText?: string,
      snoozedUntil?: number
    ) => {
      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction,
          responseText,
          snoozedUntil,
        })
      } catch (error) {
        console.error("Failed to swipe action:", error)
      }
    },
    [swipeAction]
  )

  // Map actions to CardStack format
  const cardActions: ActionWithId[] = React.useMemo(
    () =>
      actions.map((action) => ({
        id: action._id,
        type: action.type,
        action: action as EnrichedAction,
      })),
    [actions]
  )

  // Loading skeleton
  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4">
        <Skeleton className="w-full max-w-lg h-[500px] rounded-2xl" />
        <div className="flex gap-4 mt-6">
          <Skeleton className="h-11 w-24 rounded-md" />
          <Skeleton className="h-11 w-24 rounded-md" />
          <Skeleton className="h-11 w-24 rounded-md" />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with action buttons and keyboard hints */}
      <div className="absolute top-4 right-4 flex items-center gap-4 z-10">
        <Button
          variant="outline"
          size="sm"
          onClick={handleScan}
          disabled={scanning}
        >
          {scanning ? "Scanning..." : "Scan Now"}
        </Button>
        <span className="text-xs text-muted-foreground opacity-60">
          <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] mr-1">
            ←
          </kbd>
          Discard
          <span className="mx-2">·</span>
          <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] mr-1">
            ↑
          </kbd>
          Snooze
          <span className="mx-2">·</span>
          <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] mr-1">
            →
          </kbd>
          Send
        </span>
      </div>

      {/* Filter Panel - Right Sidebar */}
      <div className="absolute top-4 right-4 mt-14 z-10">
        <div className="bg-card border rounded-lg p-3">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Filter
          </div>
          <ActionFilterChips
            counts={counts}
            total={totalFromCounts}
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            vertical
          />
        </div>
      </div>

      {/* Card Stack - using internal registry via topActionContext */}
      <CardStack<ActionWithId>
        actions={cardActions}
        totalCount={filterTypes ? actions.length : totalCount}
        onSwipe={handleSwipe}
        topActionContext={contextResult as ActionContext | null}
      />
    </div>
  )
}

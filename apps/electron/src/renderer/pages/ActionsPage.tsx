import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import {
  Clock,
  MessageSquare,
  UserPlus,
  Trash2,
} from "lucide-react"
import { AnimatePresence } from "motion/react"
import { api } from "@cued/convex"
import { type EnrichedAction, PLATFORM_CONFIG, type ActionPlatform, getPlatformDeeplink, getContactDeeplink, type DeeplinkResult } from "@cued/shared"
import {
  ACTION_FILTER_GROUPS,
  type FilterGroup,
  type ActionContext,
  type OpenInAppConfig,
} from "@cued/ui"
import { renderActionCard } from "@cued/ui"
import { ActionFilterDropdown, type ActionFilterDropdownRef } from "@cued/ui"
import { Skeleton, Button, EmptyState, PlatformIcon, SparklesIcon, PartyPopperIcon } from "@cued/ui"
import type { Id } from "@cued/convex"
import { useElectron } from "../hooks/use-electron"
import { Panel, PanelHeader } from "../components/app-shell"
import { SnoozeModal } from "../components/SnoozeModal"
import { SwipeableActionListItem } from "../components/SwipeableActionListItem"
import { UndoToast } from "../components/UndoToast"

const EMPTY_ACTIONS: EnrichedAction[] = []
const EMPTY_COUNTS: Record<string, number> = {}
const HIDDEN_UNDO_TOAST = { visible: false, message: "", messageId: null }

const ACTION_TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string }> = {
  respond: { icon: <MessageSquare className="w-4 h-4" />, label: "Reply needed" },
  send_message: { icon: <MessageSquare className="w-4 h-4" />, label: "Send message" },
  follow_up: { icon: <Clock className="w-4 h-4" />, label: "Follow up" },
  eod_contact: { icon: <Clock className="w-4 h-4" />, label: "Check in" },
  new_connection: { icon: <UserPlus className="w-4 h-4" />, label: "New connection" },
  resolve_contact: { icon: <UserPlus className="w-4 h-4" />, label: "Merge contacts" },
}

const DEFAULT_ACTION_CONFIG = { icon: <MessageSquare className="w-4 h-4" />, label: "" }

function getActionTypeConfig(type: string): { icon: React.ReactNode; label: string } {
  const config = ACTION_TYPE_CONFIG[type]
  if (config) return config
  return { ...DEFAULT_ACTION_CONFIG, label: type }
}

/** Build OpenInAppConfig from a deeplink result. */
function buildOpenInAppConfig(
  deeplinkResult: (DeeplinkResult & { platform?: string }) | null,
  openExternal: (url: string) => void,
): OpenInAppConfig | null {
  if (!deeplinkResult) return null
  const p = deeplinkResult.platform as ActionPlatform | undefined
  const config = p ? PLATFORM_CONFIG[p] : null
  if (!config || !p) return null

  return {
    onOpenInApp: deeplinkResult.type === "available"
      ? () => openExternal(deeplinkResult.url)
      : undefined,
    label: `Open ${config.label}`,
    icon: (
      <span className={deeplinkResult.type === "disabled" ? undefined : config.textClass}>
        <PlatformIcon platform={p} className="w-3.5 h-3.5" />
      </span>
    ),
    disabledReason: deeplinkResult.type === "disabled" ? deeplinkResult.reason : null,
  }
}

interface ActionDetailProps {
  action: EnrichedAction | null
  context: ActionContext | null
  responseText: string
  onResponseChange: (text: string) => void
  onSend?: () => void
  onDismiss?: () => void
  isSending?: boolean
  openExternal: (url: string) => void
}

function ActionDetail({
  action,
  context,
  responseText,
  onResponseChange,
  onSend,
  onDismiss,
  isSending,
  openExternal,
}: ActionDetailProps) {
  if (!action) {
    return (
      <EmptyState
        animatedIcon={SparklesIcon}
        title="Select an action"
        description="Pick one from the list to review and respond"
      />
    )
  }

  const platform = (action.platform ?? context?.conversation?.platform) as ActionPlatform | undefined
  const deeplinkResult = platform ? getPlatformDeeplink(platform, context?.conversation ?? null, context?.contact ?? null) : null
  const openInApp = buildOpenInAppConfig(
    deeplinkResult ? { ...deeplinkResult, platform } : null,
    openExternal,
  )

  // Per-contact deep links for resolve_contact actions
  const contact1OpenInApp = action.type === "resolve_contact" && context?.contact
    ? buildOpenInAppConfig(getContactDeeplink(context.contact.handles), openExternal)
    : null
  const contact2OpenInApp = action.type === "resolve_contact" && context?.secondaryContact
    ? buildOpenInAppConfig(getContactDeeplink(context.secondaryContact.handles), openExternal)
    : null

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {renderActionCard({
          action,
          isTop: true,
          context,
          responseText,
          onResponseChange,
          onSend,
          onDismiss,
          isSending,
          autoFocus: false,
          className: "h-full border-0 shadow-none rounded-none",
          openInApp,
          contact1OpenInApp,
          contact2OpenInApp,
          onLinkClick: (url: string) => openExternal(url),
        })}
      </div>
    </div>
  )
}

interface ActionsPageProps {
  onActionCountChange?: (count: number) => void
}

export function ActionsPage({
  onActionCountChange,
}: ActionsPageProps): React.JSX.Element {
  const electron = useElectron()

  // Filter state
  const filterRef = React.useRef<ActionFilterDropdownRef>(null)
  const [activeFilter, setActiveFilter] = React.useState<FilterGroup>("all")
  const [activePlatforms, setActivePlatforms] = React.useState<Set<ActionPlatform>>(new Set())
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(
    null
  )
  const [responseTexts, setResponseTexts] = React.useState<
    Record<string, string>
  >({})
  const [isProcessing, setIsProcessing] = React.useState(false)

  // Multi-select state
  const [multiSelectedIds, setMultiSelectedIds] = React.useState<Set<string>>(
    new Set()
  )
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null)
  const isMultiSelectMode = multiSelectedIds.size > 0

  // Snooze modal state
  const [snoozeModalOpen, setSnoozeModalOpen] = React.useState(false)

  // Undo toast state
  const [undoToast, setUndoToast] = React.useState<{
    visible: boolean
    message: string
    messageId: string | null
  }>(HIDDEN_UNDO_TOAST)

  // Get action types to filter by based on active filter group
  const filterTypes = React.useMemo(
    () => ACTION_FILTER_GROUPS[activeFilter].types as readonly string[] | null,
    [activeFilter]
  )

  // Fetch pending actions list
  const actionsResult = useQuery(api.actions.getPendingActions, { limit: 50 })
  const countsResult = useQuery(api.actions.getActionCountsByType, {})

  // Filter actions client-side based on active filter group + platform
  const rawActions = actionsResult?.actions ?? EMPTY_ACTIONS
  const actions = React.useMemo(() => {
    let filtered = rawActions
    if (filterTypes) {
      filtered = filtered.filter((a) => filterTypes.includes(a.type))
    }
    if (activePlatforms.size > 0) {
      filtered = filtered.filter((a) => a.platform != null && activePlatforms.has(a.platform as ActionPlatform))
    }
    return filtered
  }, [rawActions, filterTypes, activePlatforms])

  // Compute platform counts from type-filtered actions (so platform counts update when type filter changes)
  const platformCounts = React.useMemo(() => {
    let typeFiltered = rawActions
    if (filterTypes) {
      typeFiltered = typeFiltered.filter((a) => filterTypes.includes(a.type))
    }
    const counts: Partial<Record<ActionPlatform, number>> = {}
    for (const action of typeFiltered) {
      if (action.platform) {
        const p = action.platform as ActionPlatform
        counts[p] = (counts[p] ?? 0) + 1
      }
    }
    return counts
  }, [rawActions, filterTypes])

  const counts = countsResult?.counts ?? EMPTY_COUNTS
  const totalFromCounts = countsResult?.total ?? 0
  const loading = actionsResult === undefined

  // Report action count to parent
  React.useEffect(() => {
    onActionCountChange?.(totalFromCounts)
  }, [totalFromCounts, onActionCountChange])

  // Track selected action's index so we can select the next one after removal
  const selectedIndexRef = React.useRef(0)
  React.useEffect(() => {
    if (selectedActionId) {
      const idx = actions.findIndex((a) => a._id === selectedActionId)
      if (idx !== -1) selectedIndexRef.current = idx
    }
  }, [selectedActionId, actions])

  // Auto-select next action when current is removed, or first action on initial load
  React.useEffect(() => {
    if (
      actions.length > 0 &&
      (!selectedActionId || !actions.find((a) => a._id === selectedActionId))
    ) {
      // Select the action at the same index (next one moved up) or last if at end
      const nextIndex = Math.min(selectedIndexRef.current, actions.length - 1)
      setSelectedActionId(actions[nextIndex]._id)
    } else if (actions.length === 0) {
      setSelectedActionId(null)
    }
  }, [actions, selectedActionId])

  // Find selected action
  const selectedAction =
    actions.find((a) => a._id === selectedActionId) ?? null

  // Fetch full context for selected action
  const contextResult = useQuery(
    api.actions.getActionWithContext,
    selectedActionId
      ? { actionId: selectedActionId as Id<"actions">, messageLimit: 15 }
      : "skip"
  )
  const actionContext: ActionContext | null = (contextResult ?? null) as ActionContext | null

  // Mutations
  const swipeAction = useMutation(api.actions.swipeAction)
  const cancelMessage = useMutation(api.messageQueue.cancelMessage)

  // Handle response text change
  const handleResponseChange = React.useCallback(
    (text: string) => {
      if (selectedActionId) {
        setResponseTexts((prev) => ({ ...prev, [selectedActionId]: text }))
      }
    },
    [selectedActionId]
  )

  // Get current response text
  const currentResponseText = selectedActionId
    ? responseTexts[selectedActionId] ?? ""
    : ""

  // Handle swipe actions
  const handleSwipe = React.useCallback(
    async (direction: "left" | "up" | "right", snoozedUntil?: number) => {
      if (!selectedAction || isProcessing) return

      // For snooze without a time, open the modal
      if (direction === "up" && !snoozedUntil) {
        setSnoozeModalOpen(true)
        return
      }

      setIsProcessing(true)

      try {
        const responseText = responseTexts[selectedAction._id]
        const result = await swipeAction({
          actionId: selectedAction._id as Id<"actions">,
          direction,
          responseText,
          snoozedUntil,
        })

        // Show undo toast for right swipes (sent messages)
        if (direction === "right" && result.queuedMessageId) {
          setUndoToast({
            visible: true,
            message: "Message queued",
            messageId: result.queuedMessageId,
          })
        }

        // Clean up state
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[selectedAction._id]
          return next
        })
      } catch (error) {
        console.error("Failed to swipe action:", error)
      } finally {
        setIsProcessing(false)
      }
    },
    [selectedAction, isProcessing, responseTexts, swipeAction]
  )

  // Handle snooze from modal
  const handleSnooze = React.useCallback(
    async (snoozedUntil: number) => {
      await handleSwipe("up", snoozedUntil)
    },
    [handleSwipe]
  )

  // Handle discard for a specific action (from swipeable list item)
  const handleDiscardAction = React.useCallback(
    async (actionId: string) => {
      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "left",
        })
      } catch (error) {
        console.error("Failed to discard action:", error)
      }
    },
    [swipeAction]
  )

  // Handle click with multi-select support
  const handleItemClick = React.useCallback(
    (actionId: string, e: React.MouseEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      const isShift = e.shiftKey

      if (isMeta) {
        // Toggle selection
        setMultiSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(actionId)) {
            next.delete(actionId)
          } else {
            next.add(actionId)
          }
          return next
        })
        setLastClickedId(actionId)
      } else if (isShift) {
        // Range selection - use lastClickedId or selectedActionId as anchor
        const anchorId = lastClickedId ?? selectedActionId
        if (anchorId) {
          const currentIndex = actions.findIndex((a) => a._id === actionId)
          const anchorIndex = actions.findIndex((a) => a._id === anchorId)
          if (currentIndex !== -1 && anchorIndex !== -1) {
            const start = Math.min(currentIndex, anchorIndex)
            const end = Math.max(currentIndex, anchorIndex)
            const rangeIds = actions.slice(start, end + 1).map((a) => a._id)
            setMultiSelectedIds(new Set(rangeIds))
            setLastClickedId(actionId)
          }
        }
      } else {
        // Normal click - clear selection and select for detail view
        setMultiSelectedIds(new Set())
        setSelectedActionId(actionId)
        setLastClickedId(actionId)
      }
    },
    [actions, lastClickedId, selectedActionId]
  )

  // Handle bulk dismiss
  const handleBulkDismiss = React.useCallback(async () => {
    if (multiSelectedIds.size === 0) return
    setIsProcessing(true)
    try {
      await Promise.all(
        Array.from(multiSelectedIds).map((id) =>
          swipeAction({
            actionId: id as Id<"actions">,
            direction: "left",
          })
        )
      )
      setMultiSelectedIds(new Set())
    } catch (error) {
      console.error("Failed to bulk dismiss:", error)
    } finally {
      setIsProcessing(false)
    }
  }, [multiSelectedIds, swipeAction])

  // Clear multi-selection
  const clearSelection = React.useCallback(() => {
    setMultiSelectedIds(new Set())
  }, [])

  // Handle undo
  const handleUndo = React.useCallback(async () => {
    if (!undoToast.messageId) return
    try {
      await cancelMessage({
        messageId: undoToast.messageId as Id<"messageQueue">,
      })
      setUndoToast(HIDDEN_UNDO_TOAST)
    } catch (error) {
      console.error("Failed to cancel message:", error)
    }
  }, [undoToast.messageId, cancelMessage])

  const handleDismissToast = React.useCallback(() => {
    setUndoToast(HIDDEN_UNDO_TOAST)
  }, [])

  // Open in platform app
  const handleOpenInApp = React.useCallback(() => {
    const platform = selectedAction?.platform ?? actionContext?.conversation?.platform
    if (!platform) return
    const result = getPlatformDeeplink(platform, actionContext?.conversation ?? null, actionContext?.contact ?? null)
    if (result?.type === "available") {
      electron.shell.openExternal(result.url)
    }
  }, [selectedAction, actionContext, electron])

  // Keyboard navigation
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+O: Open in platform app (works even when focused in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault()
        handleOpenInApp()
        return
      }

      // Ignore when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      // Escape clears multi-selection
      if (e.key === "Escape" && isMultiSelectMode) {
        e.preventDefault()
        clearSelection()
        return
      }

      // Backspace/Delete dismisses selected items in multi-select mode
      if ((e.key === "Backspace" || e.key === "Delete") && isMultiSelectMode) {
        e.preventDefault()
        handleBulkDismiss()
        return
      }

      // Cmd+A selects all visible actions
      if ((e.metaKey || e.ctrlKey) && e.key === "a" && actions.length > 0) {
        e.preventDefault()
        setMultiSelectedIds(new Set(actions.map((a) => a._id)))
        return
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handleSwipe("left")
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handleSwipe("right")
      } else if (e.key === "ArrowUp" && actions.length > 0) {
        // Navigate to previous action in list
        e.preventDefault()
        const currentIndex = actions.findIndex(
          (a) => a._id === selectedActionId
        )
        if (currentIndex > 0) {
          setSelectedActionId(actions[currentIndex - 1]._id)
        }
      } else if (e.key === "ArrowDown" && actions.length > 0) {
        // Navigate to next action in list
        e.preventDefault()
        const currentIndex = actions.findIndex(
          (a) => a._id === selectedActionId
        )
        if (currentIndex < actions.length - 1) {
          setSelectedActionId(actions[currentIndex + 1]._id)
        }
      } else if (e.key === "s" || e.key === "S") {
        // Snooze action - opens modal
        e.preventDefault()
        handleSwipe("up")
      } else if (e.key === "i" || e.key === "I") {
        // Focus the response input (vim-like insert mode)
        e.preventDefault()
        const textarea = document.querySelector(
          "[data-response-input]"
        ) as HTMLTextAreaElement | null
        textarea?.focus()
      } else if (e.key === "f" || e.key === "F") {
        // Open filter dropdown
        e.preventDefault()
        filterRef.current?.open()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleSwipe, handleOpenInApp, actions, selectedActionId, isMultiSelectMode, clearSelection, handleBulkDismiss])

  // Loading skeleton
  if (loading) {
    return (
      <>
        {/* List Panel */}
        <Panel variant="shrink" width={320} position="first">
          <PanelHeader title="Actions" />
          <div className="p-3 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        </Panel>

        {/* Detail Panel */}
        <Panel position="last" className="p-6">
          <Skeleton className="h-full w-full rounded-lg" />
        </Panel>
      </>
    )
  }

  return (
    <>
      {/* List Panel */}
      <Panel variant="shrink" width={320} position="first">
        <PanelHeader title="Actions">
          <ActionFilterDropdown
            ref={filterRef}
            counts={counts}
            total={totalFromCounts}
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            platformCounts={platformCounts}
            activePlatforms={activePlatforms}
            onPlatformToggle={(platform) => {
              setActivePlatforms((prev) => {
                const next = new Set(prev)
                if (next.has(platform)) {
                  next.delete(platform)
                } else {
                  next.add(platform)
                }
                return next
              })
            }}
          />
        </PanelHeader>

        {/* Action List */}
        <div className="flex-1 overflow-y-auto p-2">
          {actions.length === 0 ? (
            <EmptyState
              animatedIcon={PartyPopperIcon}
              title="You're all caught up"
              description="New actions will appear as Cued finds opportunities"
              className="py-12"
            />
          ) : (
            <AnimatePresence mode="popLayout">
              {actions.map((action) => (
                <SwipeableActionListItem
                  key={action._id}
                  action={action}
                  selected={selectedActionId === action._id}
                  multiSelected={multiSelectedIds.has(action._id)}
                  showCheckbox={isMultiSelectMode}
                  onClick={(e) => handleItemClick(action._id, e)}
                  onDiscard={() => handleDiscardAction(action._id)}
                  typeConfig={getActionTypeConfig(action.type)}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Bulk operations bar */}
        {isMultiSelectMode && (
          <div className="shrink-0 p-2 border-t border-border bg-background">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {multiSelectedIds.size} selected
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDismiss}
                disabled={isProcessing}
              >
                <Trash2 className="size-4 mr-1.5" />
                Dismiss All
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {/* Detail Panel */}
      <Panel position="last">
        <ActionDetail
          action={selectedAction}
          context={actionContext}
          responseText={currentResponseText}
          onResponseChange={handleResponseChange}
          onSend={() => handleSwipe("right")}
          onDismiss={() => handleSwipe("left")}
          isSending={isProcessing}
          openExternal={(url) => electron.shell.openExternal(url)}
        />
      </Panel>

      {/* Snooze Modal */}
      <SnoozeModal
        open={snoozeModalOpen}
        onClose={() => setSnoozeModalOpen(false)}
        onSnooze={handleSnooze}
      />

      {/* Undo Toast */}
      <UndoToast
        visible={undoToast.visible}
        message={undoToast.message}
        onUndo={handleUndo}
        onDismiss={handleDismissToast}
      />
    </>
  )
}

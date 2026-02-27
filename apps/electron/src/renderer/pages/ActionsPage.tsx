import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { Clock, MessageCircle, UserPlus, Trash2, CheckCircle2, X } from 'lucide-react'
import { AnimatePresence } from "motion/react"
import { api } from "@cued/convex"
import { type EnrichedAction, PLATFORM_CONFIG, type ActionPlatform, getPlatformDeeplink, getContactDeeplink, type DeeplinkResult, formatRelativeTime, isMessageActionType } from "@cued/shared"
import {
  ACTION_FILTER_GROUPS,
  getGroupCount,
  type FilterGroup,
  type ActionContext,
  type OpenInAppConfig,
} from "@cued/ui"
import { renderActionCard } from "@cued/ui"
import { ActionFilterDropdown, type ActionFilterDropdownRef } from "../components/action-filter-dropdown"
import { Skeleton, Button, EmptyState, PlatformIcon, SparklesIcon, PartyPopperIcon, cn } from "@cued/ui"
import type { Id } from "@cued/convex"
import { useElectron } from "../hooks/use-electron"
import { Panel, PanelHeader } from "../components/app-shell"
import { SnoozeModal } from "../components/SnoozeModal"
import { SwipeableActionListItem } from "../components/SwipeableActionListItem"
import { toast } from "sonner"

const PAGE_SIZE = 25
const MESSAGE_PAGE_SIZE = 25
const ACTION_CONTEXT_MESSAGE_LIMIT = 15
const EMPTY_ACTIONS: EnrichedAction[] = []
const EMPTY_COUNTS: Record<string, number> = {}


const ACTION_TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string }> = {
  respond: { icon: <MessageCircle size={16} strokeWidth={1.5} />, label: "Reply needed" },
  send_message: { icon: <MessageCircle size={16} strokeWidth={1.5} />, label: "Send message" },
  follow_up: { icon: <Clock size={16} strokeWidth={1.5} />, label: "Follow up" },
  resolve_contact: { icon: <UserPlus size={16} strokeWidth={1.5} />, label: "Merge contacts" },
}

const DEFAULT_ACTION_CONFIG = { icon: <MessageCircle size={16} strokeWidth={1.5} />, label: "" }

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
  onContactClick?: (contactId: string) => void
  hasMore?: boolean
  onLoadMore?: () => void
  isLoadingMore?: boolean
  readOnly?: boolean
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
  onContactClick,
  hasMore,
  onLoadMore,
  isLoadingMore,
  readOnly,
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
          responseText: readOnly ? "" : responseText,
          onResponseChange: readOnly ? () => {} : onResponseChange,
          onSend: readOnly ? undefined : onSend,
          onDismiss: readOnly ? undefined : onDismiss,
          isSending,
          autoFocus: false,
          className: "h-full border-0 shadow-none rounded-none",
          openInApp,
          contact1OpenInApp,
          contact2OpenInApp,
          onLinkClick: (url: string) => openExternal(url),
          onContactClick,
          hasMore,
          onLoadMore,
          isLoadingMore,
          readOnly,
        })}
      </div>
    </div>
  )
}

interface ActionsPageProps {
  onActionCountChange?: (count: number) => void
  onContactClick?: (contactId: string) => void
}

export function ActionsPage({
  onActionCountChange,
  onContactClick,
}: ActionsPageProps): React.JSX.Element {
  const electron = useElectron()

  // View mode: queue (pending actions) or history (completed/discarded)
  const [viewMode, setViewMode] = React.useState<"queue" | "history">("queue")
  const isHistoryMode = viewMode === "history"

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

  // Infinite scroll state
  const [loadLimit, setLoadLimit] = React.useState(PAGE_SIZE)
  const listRef = React.useRef<HTMLDivElement>(null)

  // Snooze modal state
  const [snoozeModalOpen, setSnoozeModalOpen] = React.useState(false)
  const [snoozeTargetActionId, setSnoozeTargetActionId] = React.useState<string | null>(null)

  // Track which row currently has a revealed swipe action
  const [openSwipeItemId, setOpenSwipeItemId] = React.useState<string | null>(null)
  const [optimisticallyDiscardedIds, setOptimisticallyDiscardedIds] = React.useState<Set<string>>(new Set())

  // Reset state when switching between queue and history
  const handleViewModeChange = React.useCallback((mode: "queue" | "history") => {
    setViewMode(mode)
    setSelectedActionId(null)
    setLoadLimit(PAGE_SIZE)
    setHistoryLoadLimit(PAGE_SIZE)
    setMultiSelectedIds(new Set())
    setOpenSwipeItemId(null)
  }, [])

  // Get action types to filter by based on active filter group
  const filterTypes = React.useMemo(
    () => ACTION_FILTER_GROUPS[activeFilter].types as readonly string[] | null,
    [activeFilter]
  )

  // Fetch pending actions list with progressive limit for infinite scroll
  const actionsResult = useQuery(api.actions.getPendingActions, !isHistoryMode ? { limit: loadLimit } : "skip")
  const countsResult = useQuery(api.actions.getActionCountsByType, !isHistoryMode ? {} : "skip")

  // Fetch history actions (completed + discarded)
  const [historyLoadLimit, setHistoryLoadLimit] = React.useState(PAGE_SIZE)
  const historyResult = useQuery(api.actions.getActionHistory, isHistoryMode ? { limit: historyLoadLimit } : "skip")
  const prevHistoryResult = React.useRef(historyResult)
  if (historyResult !== undefined) {
    prevHistoryResult.current = historyResult
  }
  const effectiveHistoryResult = historyResult ?? prevHistoryResult.current
  const historyActions = effectiveHistoryResult?.actions ?? EMPTY_ACTIONS
  const hasMoreHistory = effectiveHistoryResult?.nextCursor != null
  const isLoadingMoreHistory = historyLoadLimit > PAGE_SIZE && historyResult === undefined

  // Keep previous result while loading more (avoids flash to skeleton on scroll)
  const prevActionsResult = React.useRef(actionsResult)
  if (actionsResult !== undefined) {
    prevActionsResult.current = actionsResult
  }
  const effectiveResult = actionsResult ?? prevActionsResult.current
  const hasMore = effectiveResult?.nextCursor != null
  const isLoadingMoreActions = loadLimit > PAGE_SIZE && actionsResult === undefined

  // Load more when scrolling near the bottom
  const handleListScroll = React.useCallback(() => {
    const el = listRef.current
    if (!el || !hasMore || isLoadingMoreActions) return
    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight - scrollTop - clientHeight < 200) {
      setLoadLimit((prev) => prev + PAGE_SIZE)
    }
  }, [hasMore, isLoadingMoreActions])

  // Filter actions client-side based on active filter group + platform
  const rawActions = effectiveResult?.actions ?? EMPTY_ACTIONS
  React.useEffect(() => {
    if (optimisticallyDiscardedIds.size === 0) return

    const currentIds = new Set(rawActions.map((action) => action._id))
    setOptimisticallyDiscardedIds((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const actionId of prev) {
        if (currentIds.has(actionId)) {
          next.add(actionId)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [rawActions, optimisticallyDiscardedIds.size])

  const addOptimisticDiscards = React.useCallback((actionIds: readonly string[]) => {
    if (actionIds.length === 0) return
    setOptimisticallyDiscardedIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const actionId of actionIds) {
        if (!next.has(actionId)) {
          next.add(actionId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const rollbackOptimisticDiscards = React.useCallback((actionIds: readonly string[]) => {
    if (actionIds.length === 0) return
    setOptimisticallyDiscardedIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const actionId of actionIds) {
        if (next.delete(actionId)) changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const actions = React.useMemo(() => {
    if (isHistoryMode) return historyActions
    let filtered = rawActions
    if (optimisticallyDiscardedIds.size > 0) {
      filtered = filtered.filter((a) => !optimisticallyDiscardedIds.has(a._id))
    }
    if (filterTypes) {
      filtered = filtered.filter((a) => filterTypes.includes(a.type))
    }
    if (activePlatforms.size > 0) {
      filtered = filtered.filter((a) => a.platform != null && activePlatforms.has(a.platform as ActionPlatform))
    }
    return filtered
  }, [isHistoryMode, historyActions, rawActions, filterTypes, activePlatforms, optimisticallyDiscardedIds])

  // Compute platform counts from type-filtered actions (so platform counts update when type filter changes)
  const platformCounts = React.useMemo(() => {
    let typeFiltered = rawActions
    if (optimisticallyDiscardedIds.size > 0) {
      typeFiltered = typeFiltered.filter((a) => !optimisticallyDiscardedIds.has(a._id))
    }
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
  }, [rawActions, filterTypes, optimisticallyDiscardedIds])

  const counts = countsResult?.counts ?? EMPTY_COUNTS
  const totalFromCounts = countsResult?.total ?? 0
  const loading = isHistoryMode ? historyResult === undefined : effectiveResult === undefined

  const viewModeToggle = (
    <div className="no-drag flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
      <button
        onClick={() => handleViewModeChange("queue")}
        className={cn(
          "px-3 py-0.5 text-xs font-medium rounded-[5px] transition-colors",
          viewMode === "queue" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
        )}
      >
        Queue
      </button>
      <button
        onClick={() => handleViewModeChange("history")}
        className={cn(
          "px-3 py-0.5 text-xs font-medium rounded-[5px] transition-colors",
          viewMode === "history" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
        )}
      >
        History
      </button>
    </div>
  )

  // Compute the true filtered total from backend counts (not limited by loaded page size)
  const filteredTotal = React.useMemo(() => {
    if (activePlatforms.size > 0) {
      // Platform filtering is client-side only, so use loaded & filtered count
      return actions.length
    }
    return getGroupCount(activeFilter, counts, totalFromCounts)
  }, [activeFilter, activePlatforms.size, counts, totalFromCounts, actions.length])

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

  // Reset open swipe target if that action disappears
  React.useEffect(() => {
    if (!openSwipeItemId) return
    if (!actions.some((a) => a._id === openSwipeItemId)) {
      setOpenSwipeItemId(null)
    }
  }, [actions, openSwipeItemId])

  // Find selected action
  const selectedAction =
    actions.find((a) => a._id === selectedActionId) ?? null
  const selectedActionIndex = selectedActionId
    ? actions.findIndex((a) => a._id === selectedActionId)
    : -1
  const nextSequentialAction =
    selectedActionIndex >= 0
      ? actions[selectedActionIndex + 1] ?? actions[selectedActionIndex - 1] ?? null
      : null

  // Fetch full context for selected action
  const contextResult = useQuery(
    api.actions.getActionWithContext,
    selectedActionId
      ? { actionId: selectedActionId as Id<"actions">, messageLimit: ACTION_CONTEXT_MESSAGE_LIMIT }
      : "skip"
  )
  const actionContext: ActionContext | null = (contextResult ?? null) as ActionContext | null

  // Warm next likely action in cache to reduce latency when advancing.
  useQuery(
    api.actions.getActionWithContext,
    nextSequentialAction
      ? {
          actionId: nextSequentialAction._id as Id<"actions">,
          messageLimit: ACTION_CONTEXT_MESSAGE_LIMIT,
        }
      : "skip"
  )

  // Paginated message loading for selected action's conversation
  const [messageLimit, setMessageLimit] = React.useState(MESSAGE_PAGE_SIZE)

  // Reset message limit when selected action changes
  React.useEffect(() => {
    setMessageLimit(MESSAGE_PAGE_SIZE)
  }, [selectedActionId])

  const conversationId = actionContext?.conversation?._id
  const messagesResult = useQuery(
    api.messages.getMessages,
    conversationId
      ? { conversationId: conversationId as Id<"conversations">, limit: messageLimit }
      : "skip"
  )
  const nextConversationId = nextSequentialAction?.conversationId
  useQuery(
    api.messages.getMessages,
    nextConversationId
      ? { conversationId: nextConversationId as Id<"conversations">, limit: MESSAGE_PAGE_SIZE }
      : "skip"
  )

  // Build context with paginated messages (overriding getActionWithContext messages)
  const paginatedContext = React.useMemo<ActionContext | null>(() => {
    if (!actionContext) return null
    if (!messagesResult?.messages) return actionContext

    // Build fallback map from action context reactions for messages that
    // appear in both sources (action context may have richer reactor data)
    const fallbackReactionsByMessageId = new Map<string, ActionContext["messages"][0]["reactions"]>()
    for (const message of actionContext.messages) {
      if (message.reactions && message.reactions.length > 0) {
        fallbackReactionsByMessageId.set(message._id, message.reactions)
      }
    }

    // Map getMessages response to ActionContext.messages format
    // getMessages returns newest-first, reverse to chronological
    const paginatedMessages = [...messagesResult.messages].reverse().map((msg) => ({
      reactions: msg.reactions ?? fallbackReactionsByMessageId.get(msg._id) ?? null,
      _id: msg._id,
      content: msg.content,
      sentAt: msg.sentAt,
      isFromMe: msg.isFromMe,
      senderName: msg.sender?.displayName ?? (msg.isFromMe ? "You" : null),
      senderContactId: msg.senderContactId ?? null,
      status: msg.status ?? null,
    }))

    return { ...actionContext, messages: paginatedMessages }
  }, [actionContext, messagesResult])

  const hasMoreMessages = messagesResult?.nextCursor != null
  const handleLoadMoreMessages = React.useCallback(() => {
    setMessageLimit((prev) => prev + MESSAGE_PAGE_SIZE)
  }, [])
  const isLoadingMoreMessages = messageLimit > MESSAGE_PAGE_SIZE && messagesResult === undefined

  // Mutations
  const swipeAction = useMutation(api.actions.swipeAction)
  const discardActionsBulk = useMutation(api.actions.discardActionsBulk)

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
        setSnoozeTargetActionId(selectedAction._id)
        setSnoozeModalOpen(true)
        return
      }

      setIsProcessing(true)
      const isOptimisticHide =
        direction === "left" || (direction === "up" && typeof snoozedUntil === "number")
      if (isOptimisticHide) {
        addOptimisticDiscards([selectedAction._id])
      }

      try {
        const actionName = selectedAction.contactName
        const responseText = responseTexts[selectedAction._id]
        await swipeAction({
          actionId: selectedAction._id as Id<"actions">,
          direction,
          responseText,
          snoozedUntil,
        })

        // Show confirmation toast only for message send actions.
        if (direction === "right" && isMessageActionType(selectedAction.type)) {
          toast.success(actionName ? `Message sent to ${actionName}` : "Message sent")
        }

        // Clean up state
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[selectedAction._id]
          return next
        })
      } catch (error) {
        if (direction === "left") {
          rollbackOptimisticDiscards([selectedAction._id])
          toast.error("Couldn't discard action. It was restored.")
        } else if (direction === "up" && typeof snoozedUntil === "number") {
          rollbackOptimisticDiscards([selectedAction._id])
          toast.error("Couldn't snooze action. It was restored.")
        }
        console.error("Failed to swipe action:", error)
      } finally {
        setIsProcessing(false)
        setOpenSwipeItemId(null)
      }
    },
    [selectedAction, isProcessing, responseTexts, addOptimisticDiscards, rollbackOptimisticDiscards, swipeAction]
  )

  const performSnoozeAction = React.useCallback(
    async (actionId: string, snoozedUntil: number) => {
      if (isProcessing) return

      addOptimisticDiscards([actionId])
      setIsProcessing(true)
      try {
        const responseText = responseTexts[actionId]
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "up",
          responseText,
          snoozedUntil,
        })
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[actionId]
          return next
        })
      } catch (error) {
        rollbackOptimisticDiscards([actionId])
        toast.error("Couldn't snooze action. It was restored.")
        console.error("Failed to snooze action:", error)
      } finally {
        setIsProcessing(false)
        setOpenSwipeItemId(null)
      }
    },
    [isProcessing, responseTexts, addOptimisticDiscards, rollbackOptimisticDiscards, swipeAction]
  )

  // Handle snooze from modal
  const handleSnooze = React.useCallback(
    async (snoozedUntil: number) => {
      const actionId = snoozeTargetActionId ?? selectedActionId
      if (!actionId) return
      await performSnoozeAction(actionId, snoozedUntil)
      setSnoozeTargetActionId(null)
    },
    [performSnoozeAction, selectedActionId, snoozeTargetActionId]
  )

  // Handle discard for a specific action (from swipeable list item)
  const handleDiscardAction = React.useCallback(
    async (actionId: string) => {
      addOptimisticDiscards([actionId])
      setOpenSwipeItemId(null)
      try {
        await swipeAction({
          actionId: actionId as Id<"actions">,
          direction: "left",
        })
      } catch (error) {
        rollbackOptimisticDiscards([actionId])
        toast.error("Couldn't discard action. It was restored.")
        console.error("Failed to discard action:", error)
      }
    },
    [addOptimisticDiscards, rollbackOptimisticDiscards, swipeAction]
  )

  // Handle snooze from list item swipe action
  const handleSnoozeAction = React.useCallback(
    (actionId: string, snoozedUntil: number) => {
      setSelectedActionId(actionId)
      setSnoozeTargetActionId(null)
      void performSnoozeAction(actionId, snoozedUntil)
    },
    [performSnoozeAction]
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
    const selectedIds = Array.from(multiSelectedIds)
    addOptimisticDiscards(selectedIds)
    setMultiSelectedIds(new Set())
    setIsProcessing(true)
    try {
      await discardActionsBulk({
        actionIds: selectedIds as Id<"actions">[],
      })
    } catch (error) {
      // Fallback for clients connected to deployments that don't yet expose discardActionsBulk.
      const fallbackResults = await Promise.allSettled(
        selectedIds.map((actionId) =>
          swipeAction({
            actionId: actionId as Id<"actions">,
            direction: "left",
          })
        )
      )

      const failedIds = selectedIds.filter(
        (_actionId, idx) => fallbackResults[idx]?.status === "rejected"
      )
      if (failedIds.length > 0) {
        rollbackOptimisticDiscards(failedIds)
        toast.error(
          failedIds.length === 1
            ? "Couldn't discard 1 action. It was restored."
            : `Couldn't discard ${failedIds.length} actions. They were restored.`
        )
        console.error("Failed to bulk dismiss actions:", error, fallbackResults)
      }
    } finally {
      setIsProcessing(false)
    }
  }, [multiSelectedIds, addOptimisticDiscards, discardActionsBulk, rollbackOptimisticDiscards, swipeAction])

  // Clear multi-selection
  const clearSelection = React.useCallback(() => {
    setMultiSelectedIds(new Set())
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

      // H: Toggle between queue and history
      if (e.key === "h" || e.key === "H") {
        e.preventDefault()
        handleViewModeChange(isHistoryMode ? "queue" : "history")
        return
      }

      // Disable action keys in history mode
      if (isHistoryMode) {
        if (e.key === "ArrowUp" && actions.length > 0) {
          e.preventDefault()
          const currentIndex = actions.findIndex((a) => a._id === selectedActionId)
          if (currentIndex > 0) {
            const nextId = actions[currentIndex - 1]._id
            setSelectedActionId(nextId)
            document.querySelector(`[data-action-item-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" })
          }
        } else if (e.key === "ArrowDown" && actions.length > 0) {
          e.preventDefault()
          const currentIndex = actions.findIndex((a) => a._id === selectedActionId)
          if (currentIndex < actions.length - 1) {
            const nextId = actions[currentIndex + 1]._id
            setSelectedActionId(nextId)
            document.querySelector(`[data-action-item-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" })
          }
        }
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
          const nextId = actions[currentIndex - 1]._id
          setSelectedActionId(nextId)
          document.querySelector(`[data-swipe-item-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" })
        }
      } else if (e.key === "ArrowDown" && actions.length > 0) {
        // Navigate to next action in list
        e.preventDefault()
        const currentIndex = actions.findIndex(
          (a) => a._id === selectedActionId
        )
        if (currentIndex < actions.length - 1) {
          const nextId = actions[currentIndex + 1]._id
          setSelectedActionId(nextId)
          document.querySelector(`[data-swipe-item-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" })
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
  }, [handleSwipe, handleOpenInApp, actions, selectedActionId, isMultiSelectMode, clearSelection, handleBulkDismiss, isHistoryMode, handleViewModeChange])

  // Loading skeleton
  if (loading) {
    return (
      <>
        {/* List Panel */}
        <Panel variant="shrink" width={320} position="first">
          <PanelHeader titleContent={viewModeToggle} />
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
        <PanelHeader titleContent={viewModeToggle}>
          {!isHistoryMode && (
            <ActionFilterDropdown
              ref={filterRef}
              counts={counts}
              total={totalFromCounts}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
              platformCounts={platformCounts}
              activePlatforms={activePlatforms}
              filteredCount={filteredTotal}
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
          )}
        </PanelHeader>

        {/* Bulk operations bar (queue mode only) */}
        {!isHistoryMode && isMultiSelectMode && (
          <div className="shrink-0 border-b border-border/80 bg-muted/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground tabular-nums">
                {multiSelectedIds.size} Selected
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={clearSelection}
                  disabled={isProcessing}
                >
                  Clear
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={handleBulkDismiss}
                  disabled={isProcessing}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Dismiss Selected
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Action List */}
        <div
          ref={listRef}
          onScroll={isHistoryMode ? () => {
            const el = listRef.current
            if (!el || !hasMoreHistory || isLoadingMoreHistory) return
            const { scrollTop, scrollHeight, clientHeight } = el
            if (scrollHeight - scrollTop - clientHeight < 200) {
              setHistoryLoadLimit((prev) => prev + PAGE_SIZE)
            }
          } : handleListScroll}
          className="flex-1 overflow-y-auto p-2"
        >
          {actions.length === 0 ? (
            <EmptyState
              animatedIcon={isHistoryMode ? SparklesIcon : PartyPopperIcon}
              title={isHistoryMode ? "No history yet" : "You're all caught up"}
              description={isHistoryMode ? "Completed actions will appear here" : "New actions will appear as Cued finds opportunities"}
              className="py-12"
            />
          ) : isHistoryMode ? (
            /* History list items (no swipe) */
            actions.map((action) => {
              const resolvedAt = action.completedAt ?? action.discardedAt ?? action.createdAt
              const isDiscarded = action.status === "discarded"
              return (
                <div key={action._id} className="mb-1">
                  <button
                    data-action-item-id={action._id}
                    onClick={() => setSelectedActionId(action._id)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 border transition-colors duration-150 ease-out hover:duration-0",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      selectedActionId === action._id ? "border-border bg-muted" : "border-transparent bg-background hover:bg-muted"
                    )}
                  >
                    <div className="shrink-0">
                      {isDiscarded ? (
                        <X size={16} strokeWidth={1.5} className="text-muted-foreground" />
                      ) : (
                        <CheckCircle2 size={16} strokeWidth={1.5} className="text-[#1B5E3D]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 text-sm font-medium truncate">
                          {action.contactName ?? "Unknown"}
                        </span>
                        <span className="shrink-0 text-[10px] tracking-tight text-muted-foreground tabular-nums">
                          {formatRelativeTime(resolvedAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                        <span>{isDiscarded ? "Skipped" : "Sent"} &middot; {action.summary ?? getActionTypeConfig(action.type).label}</span>
                      </div>
                    </div>
                  </button>
                </div>
              )
            })
          ) : (
            <AnimatePresence mode="popLayout">
              {actions.map((action) => (
                <SwipeableActionListItem
                  key={action._id}
                  action={action}
                  selected={!isMultiSelectMode && selectedActionId === action._id}
                  multiSelected={multiSelectedIds.has(action._id)}
                  showCheckbox={isMultiSelectMode}
                  onClick={(e) => handleItemClick(action._id, e)}
                  onDiscard={() => handleDiscardAction(action._id)}
                  onSnooze={(snoozedUntil) => handleSnoozeAction(action._id, snoozedUntil)}
                  typeConfig={getActionTypeConfig(action.type)}
                  onContactClick={onContactClick}
                  openSwipeId={openSwipeItemId}
                  onSwipeActiveChange={setOpenSwipeItemId}
                />
              ))}
            </AnimatePresence>
          )}
        </div>
      </Panel>

      {/* Detail Panel */}
      <Panel position="last">
        <ActionDetail
          action={selectedAction}
          context={paginatedContext}
          responseText={currentResponseText}
          onResponseChange={handleResponseChange}
          onSend={isHistoryMode ? undefined : () => handleSwipe("right")}
          onDismiss={isHistoryMode ? undefined : () => handleSwipe("left")}
          isSending={isProcessing}
          openExternal={(url) => electron.shell.openExternal(url)}
          onContactClick={onContactClick}
          hasMore={hasMoreMessages}
          onLoadMore={handleLoadMoreMessages}
          isLoadingMore={isLoadingMoreMessages}
          readOnly={isHistoryMode}
        />
      </Panel>

      {/* Snooze Modal */}
      <SnoozeModal
        open={snoozeModalOpen}
        onClose={() => {
          setSnoozeModalOpen(false)
          setSnoozeTargetActionId(null)
        }}
        onSnooze={handleSnooze}
      />
    </>
  )
}

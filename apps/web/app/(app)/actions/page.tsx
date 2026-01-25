"use client"

import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@prm/convex"
import {
  CardStack,
  MessageResponseCard,
  ResolveContactCard,
  ActionFilterChips,
  ACTION_FILTER_GROUPS,
  type SwipeDirection,
  type DisplayMessage,
  type FilterGroup,
  type ContactHandle,
  type MergeSource,
} from "@prm/ui"
import { Button, Skeleton } from "@prm/ui"
import type { Id } from "@prm/convex"

/** Action type matching enriched actions from getPendingActions */
interface EnrichedAction {
  _id: Id<"actions">
  type: string
  status: string
  priority: number
  reason: string | null
  llmReason: string | null
  createdAt: number
  snoozedUntil: number | null
  completedAt: number | null
  discardedAt: number | null
  conversationId: Id<"conversations"> | null
  contactId: Id<"contacts"> | null
  contactName: string | null
  secondaryContactId: Id<"contacts"> | null
  secondaryContactName: string | null
  // Denormalized merge data for resolve_contact actions
  mergeConfidence: number | null
  mergeSource: string | null
  mergeReasoning: string | null
  platform: string | null
}

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
  const topActionId = actions.length > 0 ? actions[0]._id : null

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

  // Track response texts locally (optimistic)
  const [responseTexts, setResponseTexts] = React.useState<
    Record<string, string>
  >({})

  // Handle response text changes
  const handleResponseChange = React.useCallback(
    (actionId: string, text: string) => {
      setResponseTexts((prev) => ({ ...prev, [actionId]: text }))
    },
    []
  )

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

        // Clean up local state
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[actionId]
          return next
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
        <div className="bg-card border rounded-lg p-3 shadow-sm">
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

      {/* Card Stack */}
      <CardStack<ActionWithId>
        actions={cardActions}
        totalCount={filterTypes ? actions.length : totalCount}
        onSwipe={handleSwipe}
        renderCard={(item, { isTop, responseText, onResponseChange }) => {
          // Handle resolve_contact actions with dedicated card
          if (item.action.type === "resolve_contact") {
            // For resolve_contact, use context to get both contacts with handles
            if (isTop && contextResult) {
              const { contact, secondaryContact } = contextResult

              // Map handles to ContactHandle format (context uses handleType/handle fields)
              const mapHandles = (handles: Array<{ handleType: string; handle: string; platform: string }> | undefined): ContactHandle[] => {
                if (!handles) return []
                return handles.map((h) => ({
                  type: h.handleType as ContactHandle["type"],
                  value: h.handle,
                  platform: h.platform as ContactHandle["platform"],
                }))
              }

              return (
                <ResolveContactCard
                  contact1={{
                    name: contact?.displayName ?? item.action.contactName ?? "Unknown",
                    company: contact?.company,
                    handles: mapHandles(contact?.handles),
                  }}
                  contact2={{
                    name: secondaryContact?.displayName ?? item.action.secondaryContactName ?? "Unknown",
                    company: secondaryContact?.company,
                    handles: mapHandles(secondaryContact?.handles),
                  }}
                  confidence={item.action.mergeConfidence ?? 0}
                  source={(item.action.mergeSource ?? "email_match") as MergeSource}
                  reasoning={item.action.mergeReasoning}
                  className="h-full"
                />
              )
            }

            // Minimal view for non-top resolve_contact cards
            return (
              <ResolveContactCard
                contact1={{
                  name: item.action.contactName ?? "Unknown",
                  company: null,
                  handles: [],
                }}
                contact2={{
                  name: item.action.secondaryContactName ?? "Unknown",
                  company: null,
                  handles: [],
                }}
                confidence={item.action.mergeConfidence ?? 0}
                source={(item.action.mergeSource ?? "email_match") as MergeSource}
                reasoning={item.action.mergeReasoning}
                className="h-full"
              />
            )
          }

          // Use local state if available, otherwise fall back to prop
          const text = responseTexts[item.id] ?? responseText ?? ""

          // For top card, use full context if available
          if (isTop && contextResult) {
            const { contact, conversation, messages } = contextResult
            // For groups/channels, use conversation displayName; for DMs use contact
            const isGroup = conversation?.conversationType !== "dm"
            const personName = isGroup
              ? (conversation?.displayName ?? item.action.contactName ?? "Group Chat")
              : (contact?.displayName ?? item.action.contactName ?? "Unknown")

            // Map messages to DisplayMessage format
            const displayMessages: DisplayMessage[] = messages.map((msg) => ({
              _id: msg._id,
              content: msg.content,
              sentAt: msg.sentAt,
              isFromMe: msg.isFromMe,
              senderName: msg.senderName,
              status: msg.status,
              // Extract emoji strings from reaction objects
              reactions: msg.reactions?.map((r) => r.emoji) ?? null,
              attachments: msg.attachments?.map((att) => ({
                filename: att.filename ?? null,
                mimeType: att.mimeType ?? null,
                url: att.url ?? null,
                thumbnailUrl: att.thumbnailUrl ?? null,
              })),
            }))

            // Get message timestamp from latest non-self message
            const latestReceivedMsg = [...messages]
              .reverse()
              .find((m) => !m.isFromMe)
            const messageTimestamp = latestReceivedMsg?.sentAt

            return (
              <MessageResponseCard
                personName={personName}
                messageTimestamp={messageTimestamp}
                messages={displayMessages}
                responseText={text}
                onResponseChange={(newText) => {
                  onResponseChange(newText)
                  handleResponseChange(item.id, newText)
                }}
                autoFocus={isTop}
                className="h-full"
              />
            )
          }

          // For non-top cards or while loading context, show minimal view
          return (
            <MessageResponseCard
              personName={item.action.contactName ?? "Unknown"}
              messages={[]}
              responseText={text}
              onResponseChange={(newText) => {
                onResponseChange(newText)
                handleResponseChange(item.id, newText)
              }}
              autoFocus={false}
              className="h-full"
            />
          )
        }}
      />
    </div>
  )
}

"use client"

import * as React from "react"
import { useQuery, useMutation, useAction } from "convex/react"
import { api } from "@prm/convex"
import {
  CardStack,
  MessageResponseCard,
  type SwipeDirection,
  type DisplayMessage,
  type DraftOption,
} from "@prm/ui"
import { Button, Skeleton } from "@prm/ui"
import type { Id } from "@prm/convex"

/** Supported platforms for style extraction */
type StylePlatform = "imessage" | "gmail" | "slack"
const STYLE_PLATFORMS: StylePlatform[] = ["imessage", "gmail", "slack"]

/** Platform display names */
const PLATFORM_LABELS: Record<StylePlatform, string> = {
  imessage: "iMessage",
  gmail: "Gmail",
  slack: "Slack",
}

/** Draft option from Convex (with string label) */
interface ConvexDraftOption {
  text: string
  label: string
  confidence: number
  assumptions: string[]
  styleSources: string[]
  riskFlags: { type: string; trigger: string }[]
}

/** Action type matching enriched actions from getPendingActions */
interface EnrichedAction {
  _id: Id<"actions">
  type: string
  status: string
  priority: number
  draftResponse: string | null
  draftOptions: ConvexDraftOption[] | null
  selectedOptionIndex: number | null
  riskLevel: "low" | "medium" | "high" | null
  riskFlags: string[] | null
  requiresApproval: boolean | null
  reason: string | null
  llmReason: string | null
  createdAt: number
  snoozedUntil: number | null
  completedAt: number | null
  discardedAt: number | null
  conversationId: Id<"conversations"> | null
  contactId: Id<"contacts"> | null
  contactName: string | null
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

export default function ActionsPage() {
  // Fetch pending actions list
  const actionsResult = useQuery(api.actions.getPendingActions, { limit: 20 })
  const countResult = useQuery(api.actions.getPendingActionCount, {})
  const actions = actionsResult?.actions ?? EMPTY_ACTIONS
  const totalCount = countResult?.count ?? 0
  const loading = actionsResult === undefined

  // Get top action ID for context fetch
  const topActionId = actions.length > 0 ? actions[0]._id : null

  // Fetch full context for top action only
  const contextResult = useQuery(
    api.actions.getActionWithContext,
    topActionId ? { actionId: topActionId, messageLimit: 15 } : "skip"
  )

  // Mutations and actions
  const swipeAction = useMutation(api.actions.swipeAction)
  const updateDraftResponse = useMutation(api.actions.updateDraftResponse)
  const triggerScan = useMutation(api.actionQueue.triggerScanForUnanswered)
  const generateDrafts = useAction(api.actions.generateDraftOptions)
  const extractStyle = useAction(api.actions.extractStyleProfile)

  // Fetch existing style profiles
  const styleProfiles = useQuery(api.actions.getAllStyleProfiles, {})

  // Scan state
  const [scanning, setScanning] = React.useState(false)
  // Generate drafts state
  const [generating, setGenerating] = React.useState(false)
  const [generateError, setGenerateError] = React.useState<string | null>(null)
  // Extract style state
  const [extractingStyle, setExtractingStyle] = React.useState<string | null>(null)
  const [styleResult, setStyleResult] = React.useState<{
    platform: string
    profile?: Record<string, unknown>
    error?: string
  } | null>(null)

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

  // Generate draft options for the top action
  const handleGenerateDrafts = React.useCallback(async () => {
    if (!topActionId) return
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateDrafts({ actionId: topActionId })
      if (!result.success) {
        setGenerateError(result.error ?? "Failed to generate drafts")
      }
    } catch (error) {
      console.error("Failed to generate drafts:", error)
      setGenerateError(error instanceof Error ? error.message : "Unknown error")
    } finally {
      setGenerating(false)
    }
  }, [topActionId, generateDrafts])

  // Extract style profile for a platform
  const handleExtractStyle = React.useCallback(
    async (platform: "imessage" | "gmail" | "slack") => {
      setExtractingStyle(platform)
      setStyleResult(null)
      try {
        const result = await extractStyle({ platform })
        if (result.success && result.profile) {
          setStyleResult({ platform, profile: result.profile })
        } else {
          setStyleResult({ platform, error: result.error ?? "Failed to extract style" })
        }
      } catch (error) {
        console.error("Failed to extract style:", error)
        setStyleResult({
          platform,
          error: error instanceof Error ? error.message : "Unknown error",
        })
      } finally {
        setExtractingStyle(null)
      }
    },
    [extractStyle]
  )

  // Track response texts locally (optimistic)
  const [responseTexts, setResponseTexts] = React.useState<
    Record<string, string>
  >({})

  // Handle response text changes with debounced server sync
  const handleResponseChange = React.useCallback(
    (actionId: string, text: string) => {
      setResponseTexts((prev) => ({ ...prev, [actionId]: text }))
    },
    []
  )

  // Debounced sync to server
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  React.useEffect(() => {
    if (topActionId && responseTexts[topActionId]) {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
      syncTimeoutRef.current = setTimeout(() => {
        updateDraftResponse({
          actionId: topActionId,
          draftResponse: responseTexts[topActionId],
        }).catch(console.error)
      }, 500)
    }
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
    }
  }, [topActionId, responseTexts, updateDraftResponse])

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
        action,
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
      {/* Style Profiles Panel - Top Left */}
      <div className="absolute top-4 left-4 z-10 max-w-sm">
        <div className="bg-card border rounded-lg p-3 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Style Profiles
          </div>
          <div className="flex flex-wrap gap-2">
            {STYLE_PLATFORMS.map((platform) => {
              const hasProfile = styleProfiles?.some((p) => p.platform === platform)
              const isExtracting = extractingStyle === platform
              const label = PLATFORM_LABELS[platform]
              const prefix = hasProfile ? "\u2713 " : "+ "

              return (
                <Button
                  key={platform}
                  variant={hasProfile ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => handleExtractStyle(platform)}
                  disabled={isExtracting}
                  className="text-xs"
                >
                  {isExtracting ? "..." : `${prefix}${label}`}
                </Button>
              )
            })}
          </div>
          {styleResult?.error && (
            <div className="mt-2 text-xs text-destructive">{styleResult.error}</div>
          )}
          {styleResult?.profile && !styleResult.error && (
            <div className="mt-2 text-xs text-muted-foreground">
              <div>Greeting: {String(styleResult.profile.greetingStyle)}</div>
              <div>Sign-off: {String(styleResult.profile.signOffStyle)}</div>
              <div>
                Formality: {String(styleResult.profile.formalityScore)}/5 |
                Brevity: {String(styleResult.profile.brevityScore)}/5
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Header with action buttons and keyboard hints */}
      <div className="absolute top-4 right-4 flex items-center gap-4 z-10">
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerateDrafts}
          disabled={generating || !topActionId}
          title={generateError ?? undefined}
        >
          {generating ? "Generating..." : "Generate Drafts"}
        </Button>
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

      {/* Card Stack */}
      <CardStack<ActionWithId>
        actions={cardActions}
        totalCount={totalCount}
        onSwipe={handleSwipe}
        renderCard={(item, { isTop, responseText, onResponseChange }) => {
          // Use local state if available, otherwise fall back to server draft
          const text =
            responseTexts[item.id] ??
            item.action.draftResponse ??
            responseText ??
            ""

          // For top card, use full context if available
          if (isTop && contextResult) {
            const { contact, conversation, messages, action: actionContext } = contextResult
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

            // Get draft options from context (most up-to-date) or action
            const rawOptions = actionContext?.draftOptions ?? item.action.draftOptions
            const draftOptions: DraftOption[] | undefined = rawOptions?.map((opt) => ({
              ...opt,
              label: opt.label as DraftOption["label"],
            }))

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
                draftOptions={draftOptions}
                riskLevel={actionContext?.riskLevel ?? item.action.riskLevel ?? undefined}
                requiresApproval={actionContext?.requiresApproval ?? item.action.requiresApproval ?? undefined}
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

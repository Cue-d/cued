"use client"

import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@prm/convex"
import type { Id } from "@prm/convex"
import {
  CardStack,
  MessageResponseCard,
  type SwipeDirection,
  type DisplayMessage,
} from "@prm/ui"
import { Button, Input, Skeleton } from "@prm/ui"

/** Action type matching enriched actions from getPendingActions */
interface EnrichedAction {
  _id: Id<"actions">
  type: string
  status: string
  priority: number
  draftMessage: string | null
  draftResponse: string | null
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

  // Mutations
  const swipeAction = useMutation(api.actions.swipeAction)
  const updateDraftResponse = useMutation(api.actions.updateDraftResponse)
  const triggerScan = useMutation(api.actionQueue.triggerScanForUnanswered)

  const testSendMessage = useMutation(api.pendingSends.testSendMessage)

  // Scan state
  const [scanning, setScanning] = React.useState(false)

  // Test send state
  const [showTestPanel, setShowTestPanel] = React.useState(false)
  const [testPhone, setTestPhone] = React.useState("+13474468966")
  const [testMessage, setTestMessage] = React.useState("Test message from PRM!")
  const [sending, setSending] = React.useState(false)
  const [sendResult, setSendResult] = React.useState<string | null>(null)

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

  const handleTestSend = React.useCallback(async () => {
    setSending(true)
    setSendResult(null)
    try {
      const result = await testSendMessage({
        recipientHandle: testPhone,
        text: testMessage,
      })
      setSendResult(`Queued! Electron will send shortly...`)
    } catch (error) {
      setSendResult(`Error: ${error instanceof Error ? error.message : "Failed"}`)
    } finally {
      setSending(false)
    }
  }, [testSendMessage, testPhone, testMessage])

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
      {/* Header with scan button and keyboard hints */}
      <div className="absolute top-4 right-4 flex items-center gap-4 z-10">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowTestPanel(!showTestPanel)}
        >
          Test Send
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

      {/* Test Send Panel */}
      {showTestPanel && (
        <div className="absolute top-16 right-4 z-20 bg-card border rounded-lg p-4 shadow-lg w-80">
          <h3 className="font-medium mb-3">Test iMessage Send</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Phone Number</label>
              <Input
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="+1234567890"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Message</label>
              <Input
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                placeholder="Test message..."
                className="mt-1"
              />
            </div>
            <Button
              onClick={handleTestSend}
              disabled={sending || !testPhone || !testMessage}
              className="w-full"
            >
              {sending ? "Sending..." : "Send iMessage"}
            </Button>
            {sendResult && (
              <p className={`text-xs ${sendResult.startsWith("Error") ? "text-destructive" : "text-green-600"}`}>
                {sendResult}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Electron app must be running to send.
            </p>
          </div>
        </div>
      )}

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
            const { contact, conversation, messages } = contextResult
            const personName =
              contact?.displayName ??
              conversation?.displayName ??
              item.action.contactName ??
              "Unknown"

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

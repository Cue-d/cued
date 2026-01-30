import * as React from "react"
import { UndoSendToast } from "./undo-send-toast"
import type { ActionPlatform } from "@cued/shared"

/** Message data from getPendingMessages query */
export interface PendingMessage {
  _id: string
  platform: ActionPlatform
  recipientHandle: string
  recipientContactId?: string
  text: string
  scheduledFor: number
  timeRemainingMs: number
}

export interface UndoSendContextValue {
  /** Currently displayed pending messages */
  pendingMessages: PendingMessage[]
  /** IDs of messages dismissed by user (won't show again until page refresh) */
  dismissedIds: Set<string>
  /** Dismiss a toast manually (user closed it) */
  dismissMessage: (messageId: string) => void
  /** Cancel a message (undo send) */
  cancelMessage: (messageId: string) => Promise<void>
}

const UndoSendContext = React.createContext<UndoSendContextValue | null>(null)

export interface UndoSendProviderProps {
  children: React.ReactNode
  /** Pending messages from getPendingMessages query (reactive) */
  pendingMessages: PendingMessage[]
  /** Callback to cancel a message (calls cancelMessage mutation) */
  onCancelMessage: (messageId: string) => Promise<void>
  /** Callback to send a message immediately (calls sendImmediately mutation) */
  onSendNow?: (messageId: string) => Promise<void>
  /** Optional callback when message is sent (timer expired) */
  onMessageSent?: (messageId: string) => void
  /** Optional: resolve recipient name from contact ID or handle */
  getRecipientName?: (message: PendingMessage) => string
  /** Maximum number of toasts to show at once */
  maxToasts?: number
  /** Custom class for toast container */
  className?: string
}

/**
 * UndoSendProvider - Context provider that manages undo send toasts.
 *
 * Subscribes to pending messages from the message queue and renders
 * UndoSendToast components for each message still in the undo window.
 * Persists toasts across page refresh by using reactive query data.
 *
 * @example
 * ```tsx
 * // In your app layout
 * const pendingMessages = useQuery(api.messageQueue.getPendingMessages)
 * const cancelMessage = useMutation(api.messageQueue.cancelMessage)
 *
 * <UndoSendProvider
 *   pendingMessages={pendingMessages?.messages ?? []}
 *   onCancelMessage={async (id) => {
 *     await cancelMessage({ messageId: id })
 *   }}
 * >
 *   {children}
 * </UndoSendProvider>
 * ```
 */
export function UndoSendProvider({
  children,
  pendingMessages,
  onCancelMessage,
  onSendNow,
  onMessageSent,
  getRecipientName,
  maxToasts = 3,
  className,
}: UndoSendProviderProps) {
  // Track dismissed messages (user closed them manually)
  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(
    () => new Set()
  )

  // Clear dismissed IDs when corresponding messages are removed from query
  // (sent, cancelled, or timed out)
  React.useEffect(() => {
    const currentIds = new Set(pendingMessages.map((m) => m._id))
    setDismissedIds((prev) => {
      const filtered = new Set([...prev].filter((id) => currentIds.has(id)))
      // Only update if there's a change
      if (filtered.size === prev.size) return prev
      return filtered
    })
  }, [pendingMessages])

  const dismissMessage = React.useCallback((messageId: string) => {
    setDismissedIds((prev) => new Set([...prev, messageId]))
  }, [])

  const handleDismiss = React.useCallback(
    (messageId: string, reason: "sent" | "cancelled" | "closed") => {
      if (reason === "sent") {
        onMessageSent?.(messageId)
      }
      if (reason === "closed") {
        dismissMessage(messageId)
      }
      // "cancelled" is handled by onCancelMessage
    },
    [onMessageSent, dismissMessage]
  )

  const contextValue = React.useMemo<UndoSendContextValue>(
    () => ({
      pendingMessages,
      dismissedIds,
      dismissMessage,
      cancelMessage: onCancelMessage,
    }),
    [pendingMessages, dismissedIds, dismissMessage, onCancelMessage]
  )

  // Filter out dismissed messages and limit count
  const visibleMessages = React.useMemo(() => {
    return pendingMessages
      .filter((m) => !dismissedIds.has(m._id))
      .slice(0, maxToasts)
  }, [pendingMessages, dismissedIds, maxToasts])

  const defaultGetRecipientName = React.useCallback(
    (message: PendingMessage) => message.recipientHandle,
    []
  )

  const resolveRecipientName = getRecipientName ?? defaultGetRecipientName

  return (
    <UndoSendContext.Provider value={contextValue}>
      {children}

      {/* Toast container - fixed position at bottom right */}
      {visibleMessages.length > 0 && (
        <div
          className={className}
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 9999,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxWidth: 384,
            width: "100%",
            pointerEvents: "none",
          }}
        >
          {visibleMessages.map((message) => (
            <div
              key={message._id}
              style={{ pointerEvents: "auto" }}
            >
              <UndoSendToast
                messageId={message._id}
                platform={message.platform}
                recipientName={resolveRecipientName(message)}
                messagePreview={message.text}
                timeRemainingMs={message.timeRemainingMs}
                onUndo={onCancelMessage}
                onSendNow={onSendNow}
                onDismiss={handleDismiss}
              />
            </div>
          ))}
        </div>
      )}
    </UndoSendContext.Provider>
  )
}

/**
 * Hook to access the undo send context.
 * Must be used within an UndoSendProvider.
 */
export function useUndoSend(): UndoSendContextValue {
  const context = React.useContext(UndoSendContext)
  if (!context) {
    throw new Error("useUndoSend must be used within an UndoSendProvider")
  }
  return context
}

/**
 * Hook to get pending messages count (useful for badges).
 * Returns 0 if outside UndoSendProvider.
 */
export function usePendingMessagesCount(): number {
  const context = React.useContext(UndoSendContext)
  if (!context) return 0
  return context.pendingMessages.filter(
    (m) => !context.dismissedIds.has(m._id)
  ).length
}

export default UndoSendProvider

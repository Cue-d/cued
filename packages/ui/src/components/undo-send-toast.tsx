"use client"

import * as React from "react"
import { X } from "lucide-react"
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"

/** Default undo window in milliseconds (30 seconds) */
const DEFAULT_UNDO_WINDOW_MS = 30 * 1000

export interface UndoSendToastProps {
  /** Unique ID for the queued message */
  messageId: string
  /** Platform the message is being sent on */
  platform: ActionPlatform
  /** Recipient name or handle for display */
  recipientName: string
  /** Preview of message text (truncated) */
  messagePreview?: string
  /** Time remaining in ms (from server, for resuming after refresh) */
  timeRemainingMs?: number
  /** Called when user clicks Undo button */
  onUndo: (messageId: string) => void | Promise<void>
  /** Called when user clicks Send Now button to skip the undo window */
  onSendNow?: (messageId: string) => void | Promise<void>
  /** Called when toast should be dismissed (timer expired, cancelled, or closed) */
  onDismiss?: (messageId: string, reason: "sent" | "cancelled" | "closed") => void
  /** Additional class names */
  className?: string
}

/**
 * UndoSendToast - Displays a countdown toast for queued messages with undo capability.
 *
 * Shows a 30-second countdown timer after a message is queued for sending.
 * Allows the user to cancel (undo) the send before the timer expires.
 *
 * @example
 * ```tsx
 * <UndoSendToast
 *   messageId="msg_123"
 *   platform="imessage"
 *   recipientName="John Doe"
 *   messagePreview="Hey, wanted to check in..."
 *   onUndo={(id) => cancelMessage({ messageId: id })}
 *   onDismiss={(id, reason) => console.log(`Toast dismissed: ${reason}`)}
 * />
 * ```
 */
export function UndoSendToast({
  messageId,
  platform,
  recipientName,
  messagePreview,
  timeRemainingMs,
  onUndo,
  onSendNow,
  onDismiss,
  className,
}: UndoSendToastProps) {
  // Initialize time remaining from props or default to full undo window
  const [timeRemaining, setTimeRemaining] = React.useState(
    timeRemainingMs ?? DEFAULT_UNDO_WINDOW_MS
  )
  const [isUndoing, setIsUndoing] = React.useState(false)
  const [isSendingNow, setIsSendingNow] = React.useState(false)
  const [isCancelled, setIsCancelled] = React.useState(false)

  // Countdown timer
  React.useEffect(() => {
    if (isCancelled || timeRemaining <= 0) return

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        const next = prev - 100
        if (next <= 0) {
          clearInterval(interval)
          return 0
        }
        return next
      })
    }, 100)

    return () => clearInterval(interval)
  }, [isCancelled, timeRemaining])

  // Auto-dismiss when timer expires
  React.useEffect(() => {
    if (timeRemaining <= 0 && !isCancelled) {
      onDismiss?.(messageId, "sent")
    }
  }, [timeRemaining, isCancelled, messageId, onDismiss])

  const handleUndo = async () => {
    if (isUndoing || isSendingNow || isCancelled) return

    setIsUndoing(true)
    try {
      await onUndo(messageId)
      setIsCancelled(true)
      onDismiss?.(messageId, "cancelled")
    } catch {
      // If undo fails, continue countdown
      setIsUndoing(false)
    }
  }

  const handleSendNow = async () => {
    if (isUndoing || isSendingNow || isCancelled || !onSendNow) return

    setIsSendingNow(true)
    try {
      await onSendNow(messageId)
      onDismiss?.(messageId, "sent")
    } catch {
      // If send now fails, continue countdown
      setIsSendingNow(false)
    }
  }

  const handleClose = () => {
    onDismiss?.(messageId, "closed")
  }

  // Calculate progress percentage (100% = full, 0% = empty)
  const progressPercent = (timeRemaining / DEFAULT_UNDO_WINDOW_MS) * 100
  const secondsRemaining = Math.ceil(timeRemaining / 1000)

  const platformConfig = PLATFORM_CONFIG[platform]

  // Don't render if cancelled
  if (isCancelled) return null

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "relative overflow-hidden rounded-lg border bg-background shadow-lg",
        "w-full max-w-sm",
        className
      )}
    >
      {/* Progress bar at top */}
      <div
        className="absolute top-0 left-0 h-1 transition-all duration-100 ease-linear"
        style={{
          width: `${progressPercent}%`,
          backgroundColor: platformConfig.color,
        }}
      />

      <div className="flex items-start gap-3 p-4 pt-5">
        {/* Platform indicator */}
        <div
          className={cn(
            "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium",
            platformConfig.bgClass
          )}
        >
          {platformConfig.letter}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium truncate">
              Sending to {recipientName}
            </p>
            <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
              {secondsRemaining}s
            </span>
          </div>

          {messagePreview && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {messagePreview}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleUndo}
              disabled={isUndoing || isSendingNow || timeRemaining <= 0}
              className="h-7 px-3 text-xs"
            >
              {isUndoing ? "Cancelling..." : "Undo"}
            </Button>
            {onSendNow && (
              <Button
                variant="default"
                size="sm"
                onClick={handleSendNow}
                disabled={isUndoing || isSendingNow || timeRemaining <= 0}
                className="h-7 px-3 text-xs"
              >
                {isSendingNow ? "Sending..." : "Send Now"}
              </Button>
            )}
          </div>
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={handleClose}
          className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

export default UndoSendToast

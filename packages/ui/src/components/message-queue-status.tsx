import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Send,
  X,
  XCircle,
} from "lucide-react"
import { PLATFORM_CONFIG, formatRelativeTime, type ActionPlatform } from "@cued/shared"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"

/** Message queue status types */
type MessageStatus = "pending" | "sending" | "sent" | "failed" | "cancelled"

/** Message data for the status dashboard */
export interface QueuedMessageData {
  _id: string
  platform: ActionPlatform
  recipientHandle: string
  text: string
  status: MessageStatus
  scheduledFor: number
  error?: string
  attempts: number
  createdAt: number
  sentAt?: number
  cancelledAt?: number
}

/** Stats from getMessageQueueStats query */
export interface MessageQueueStats {
  pending: number
  sending: number
  sent: number
  failed: number
  cancelled: number
  total: number
}

export interface MessageQueueStatusProps {
  /** All messages to display (from query) */
  messages: QueuedMessageData[]
  /** Message queue stats */
  stats?: MessageQueueStats
  /** Callback to retry a failed message */
  onRetry: (messageId: string) => void | Promise<void>
  /** Callback to cancel a pending message */
  onCancel: (messageId: string) => void | Promise<void>
  /** Optional: resolve recipient name from handle */
  getRecipientName?: (message: QueuedMessageData) => string
  /** Whether the data is loading */
  isLoading?: boolean
  /** Additional class name */
  className?: string
}

/** Status badge for message queue */
function StatusBadge({ status }: { status: MessageStatus }) {
  const config = {
    pending: {
      icon: Clock,
      label: "Pending",
      className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    },
    sending: {
      icon: Send,
      label: "Sending",
      className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    },
    sent: {
      icon: CheckCircle2,
      label: "Sent",
      className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    },
    failed: {
      icon: XCircle,
      label: "Failed",
      className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    },
    cancelled: {
      icon: X,
      label: "Cancelled",
      className: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
    },
  }[status]

  const Icon = config.icon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        config.className
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  )
}

/** Platform badge showing letter abbreviation */
function PlatformBadge({ platform }: { platform: ActionPlatform }) {
  const config = PLATFORM_CONFIG[platform]
  return (
    <span
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium",
        config.bgClass
      )}
    >
      {config.letter}
    </span>
  )
}

/** Single message row in the list */
function MessageRow({
  message,
  recipientName,
  onRetry,
  onCancel,
  isRetrying,
  isCancelling,
}: {
  message: QueuedMessageData
  recipientName: string
  onRetry: () => void
  onCancel: () => void
  isRetrying: boolean
  isCancelling: boolean
}) {
  const canRetry = message.status === "failed"
  const canCancel = message.status === "pending"
  const timeDisplay =
    message.status === "pending"
      ? formatRelativeTime(message.scheduledFor, { allowFuture: true })
      : message.sentAt
        ? formatRelativeTime(message.sentAt)
        : formatRelativeTime(message.createdAt)

  return (
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <PlatformBadge platform={message.platform} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{recipientName}</p>
          <StatusBadge status={message.status} />
        </div>

        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {message.text}
        </p>

        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{timeDisplay}</span>
          {message.attempts > 0 && (
            <span className="text-muted-foreground/60">
              {message.attempts} attempt{message.attempts !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {message.error && (
          <div className="mt-1 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3 w-3" />
            <span className="truncate">{message.error}</span>
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        {canRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={isRetrying}
            className="h-7 px-2"
          >
            <RefreshCw
              className={cn("h-3 w-3", isRetrying && "animate-spin")}
            />
            <span className="ml-1">Retry</span>
          </Button>
        )}
        {canCancel && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isCancelling}
            className="h-7 px-2"
          >
            <X className="h-3 w-3" />
            <span className="ml-1">Cancel</span>
          </Button>
        )}
      </div>
    </div>
  )
}

/** Stats bar showing counts by status */
function StatsBar({ stats }: { stats: MessageQueueStats }) {
  const items = [
    { label: "Pending", count: stats.pending, color: "bg-yellow-500" },
    { label: "Sending", count: stats.sending, color: "bg-blue-500" },
    { label: "Sent", count: stats.sent, color: "bg-green-500" },
    { label: "Failed", count: stats.failed, color: "bg-red-500" },
    { label: "Cancelled", count: stats.cancelled, color: "bg-gray-500" },
  ]

  return (
    <div className="flex items-center gap-4 text-sm">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", item.color)} />
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium tabular-nums">{item.count}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * MessageQueueStatus - Dashboard component for viewing and managing queued messages.
 *
 * Displays messages grouped by status with options to retry failed messages
 * and cancel pending messages.
 *
 * @example
 * ```tsx
 * const messages = useQuery(api.messageQueue.getAllMessages)
 * const stats = useQuery(api.messageQueue.getMessageQueueStats)
 * const retryMessage = useMutation(api.messageQueue.retryMessage)
 * const cancelMessage = useMutation(api.messageQueue.cancelMessage)
 *
 * <MessageQueueStatus
 *   messages={messages ?? []}
 *   stats={stats}
 *   onRetry={(id) => retryMessage({ messageId: id })}
 *   onCancel={(id) => cancelMessage({ messageId: id })}
 * />
 * ```
 */
export function MessageQueueStatus({
  messages,
  stats,
  onRetry,
  onCancel,
  getRecipientName,
  isLoading,
  className,
}: MessageQueueStatusProps) {
  const [retryingIds, setRetryingIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [cancellingIds, setCancellingIds] = React.useState<Set<string>>(
    () => new Set()
  )

  const handleRetry = React.useCallback(
    async (messageId: string) => {
      setRetryingIds((prev) => new Set([...prev, messageId]))
      try {
        await onRetry(messageId)
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
      }
    },
    [onRetry]
  )

  const handleCancel = React.useCallback(
    async (messageId: string) => {
      setCancellingIds((prev) => new Set([...prev, messageId]))
      try {
        await onCancel(messageId)
      } finally {
        setCancellingIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
      }
    },
    [onCancel]
  )

  const resolveRecipientName = React.useCallback(
    (message: QueuedMessageData) =>
      getRecipientName?.(message) ?? message.recipientHandle,
    [getRecipientName]
  )

  // Group messages by status
  const grouped = React.useMemo(() => {
    const result: Record<MessageStatus, QueuedMessageData[]> = {
      pending: [],
      sending: [],
      sent: [],
      failed: [],
      cancelled: [],
    }

    for (const msg of messages) {
      result[msg.status].push(msg)
    }

    // Sort each group by createdAt descending (newest first)
    for (const status of Object.keys(result) as MessageStatus[]) {
      result[status].sort((a, b) => b.createdAt - a.createdAt)
    }

    return result
  }, [messages])

  // Calculate stats from messages if not provided
  const displayStats: MessageQueueStats = stats ?? {
    pending: grouped.pending.length,
    sending: grouped.sending.length,
    sent: grouped.sent.length,
    failed: grouped.failed.length,
    cancelled: grouped.cancelled.length,
    total: messages.length,
  }

  const activeStatuses = (
    ["pending", "sending", "failed", "sent", "cancelled"] as const
  ).filter((status) => grouped[status].length > 0)

  const defaultTab =
    grouped.pending.length > 0
      ? "pending"
      : grouped.failed.length > 0
        ? "failed"
        : grouped.sending.length > 0
          ? "sending"
          : activeStatuses[0] ?? "pending"

  const renderMessageList = (status: MessageStatus) => {
    const list = grouped[status]
    if (list.length === 0) {
      return (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No {status} messages
        </div>
      )
    }

    return (
      <div className="divide-y divide-border">
        {list.map((message) => (
          <MessageRow
            key={message._id}
            message={message}
            recipientName={resolveRecipientName(message)}
            onRetry={() => handleRetry(message._id)}
            onCancel={() => handleCancel(message._id)}
            isRetrying={retryingIds.has(message._id)}
            isCancelling={cancellingIds.has(message._id)}
          />
        ))}
      </div>
    )
  }

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Message Queue</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>Message Queue</CardTitle>
        <CardDescription>
          View and manage queued messages across all platforms
        </CardDescription>
        {displayStats.total > 0 && (
          <div className="pt-2">
            <StatsBar stats={displayStats} />
          </div>
        )}
      </CardHeader>

      <CardContent>
        {messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No messages in queue
          </div>
        ) : (
          <Tabs defaultValue={defaultTab}>
            <TabsList variant="line">
              {(
                [
                  { status: "pending", label: "Pending" },
                  { status: "sending", label: "Sending" },
                  { status: "failed", label: "Failed" },
                  { status: "sent", label: "Sent" },
                  { status: "cancelled", label: "Cancelled" },
                ] as const
              ).map(({ status, label }) => (
                <TabsTrigger key={status} value={status}>
                  {label}
                  {grouped[status].length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                      {grouped[status].length}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="mt-4">
              <TabsContent value="pending">
                {renderMessageList("pending")}
              </TabsContent>
              <TabsContent value="sending">
                {renderMessageList("sending")}
              </TabsContent>
              <TabsContent value="failed">
                {renderMessageList("failed")}
              </TabsContent>
              <TabsContent value="sent">
                {renderMessageList("sent")}
              </TabsContent>
              <TabsContent value="cancelled">
                {renderMessageList("cancelled")}
              </TabsContent>
            </div>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}

export default MessageQueueStatus

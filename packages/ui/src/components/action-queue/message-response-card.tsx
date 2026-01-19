"use client"

import * as React from "react"
import { MessageSquare, Mail, Hash, ChevronDown, AlertTriangle, Sparkles } from "lucide-react"
import { cn } from "../../lib/utils"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { Textarea } from "../ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { Badge } from "../ui/badge"

/** Platform types */
export type ActionPlatform = "imessage" | "gmail" | "slack"

/** Risk flag for a draft option */
export interface DraftRiskFlag {
  type: string
  trigger: string
}

/** A draft option with metadata */
export interface DraftOption {
  text: string
  label: "direct" | "diplomatic" | "boundary"
  confidence: number
  assumptions: string[]
  styleSources: string[]
  riskFlags: DraftRiskFlag[]
}

/** Platform config for display */
const platformConfig: Record<ActionPlatform, { label: string; icon: React.ReactNode; colorClass: string }> = {
  imessage: { label: "iMessage", icon: <MessageSquare className="w-3.5 h-3.5" />, colorClass: "text-green-600" },
  gmail: { label: "Gmail", icon: <Mail className="w-3.5 h-3.5" />, colorClass: "text-red-600" },
  slack: { label: "Slack", icon: <Hash className="w-3.5 h-3.5" />, colorClass: "text-purple-600" },
}

/** Label config for draft options */
const labelConfig: Record<DraftOption["label"], { label: string; colorClass: string }> = {
  direct: { label: "Direct", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  diplomatic: { label: "Diplomatic", colorClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  boundary: { label: "Decline", colorClass: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
}

/** Message attachment with URL */
export interface MessageAttachment {
  filename: string | null
  mimeType: string | null
  url: string | null
  thumbnailUrl?: string | null
}

/** Message data shape for display */
export interface DisplayMessage {
  _id: string
  content: string | null
  sentAt: number
  isFromMe: boolean
  senderName: string | null
  status?: string | null
  reactions?: string[] | null
  attachments?: MessageAttachment[] | null
}

export interface MessageResponseCardProps {
  /** Person name for header */
  personName: string
  /** Timestamp for relative time display */
  messageTimestamp?: number
  /** Array of messages to display */
  messages: DisplayMessage[]
  /** Current response text */
  responseText: string
  /** Called when response text changes */
  onResponseChange: (text: string) => void
  /** Optional class name */
  className?: string
  /** Auto-focus textarea on mount */
  autoFocus?: boolean
  /** Current platform for sending */
  platform?: ActionPlatform
  /** Available platforms (from contact handles) */
  availablePlatforms?: ActionPlatform[]
  /** Called when platform changes */
  onPlatformChange?: (platform: ActionPlatform) => void
  /** Draft options (new multi-option system) */
  draftOptions?: DraftOption[]
  /** Called when a draft option is selected */
  onOptionSelect?: (option: DraftOption, index: number) => void
  /** Overall risk level for the action */
  riskLevel?: "low" | "medium" | "high"
  /** Whether approval is required before sending */
  requiresApproval?: boolean
}

export interface MessageResponseCardRef {
  focusInput: () => void
}

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#"
  if (name.includes("@")) return name[0].toUpperCase()
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** Format timestamp to time string */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/** Format timestamp to relative time */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  return "Just now"
}

/** Reaction badges component */
function ReactionBadges({
  reactions,
  isSent,
}: {
  reactions: string[]
  isSent: boolean
}) {
  const displayReactions = reactions.slice(0, 3)
  return (
    <div
      className={cn(
        "absolute -top-3 flex gap-0.5 px-2 py-1 rounded-full bg-muted shadow-sm text-sm z-10 border",
        isSent ? "-left-3" : "-right-3"
      )}
    >
      {displayReactions.map((emoji, idx) => (
        <span key={idx}>{emoji}</span>
      ))}
    </div>
  )
}

/** Delivery status indicator */
function DeliveryStatus({ status }: { status?: string | null }) {
  if (status === "failed") {
    return (
      <span className="text-destructive" title="Failed to send">
        !
      </span>
    )
  }
  if (status === "read") {
    return (
      <span className="text-blue-400" title="Read">
        Read
      </span>
    )
  }
  if (status === "delivered") {
    return (
      <span className="opacity-60" title="Delivered">
        Delivered
      </span>
    )
  }
  return (
    <span className="opacity-40" title="Sent">
      Sent
    </span>
  )
}

/** Attachment display component */
function AttachmentDisplay({
  attachments,
}: {
  attachments: MessageAttachment[]
}) {
  return (
    <div className="space-y-1 mb-1">
      {attachments.map((att, idx) => {
        const isImage = att.mimeType?.startsWith("image/")
        const url = att.thumbnailUrl || att.url

        if (isImage && url) {
          return (
            <img
              key={idx}
              src={url}
              alt={att.filename || "Image"}
              className="max-w-[200px] max-h-[200px] rounded-lg object-cover"
            />
          )
        }

        return (
          <div
            key={idx}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="truncate max-w-[150px]">
              {att.filename || "Attachment"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * MessageResponseCard component for action queue.
 * Displays message history and response textarea.
 */
/** Draft option button component */
function DraftOptionButton({
  option,
  index,
  onSelect,
}: {
  option: DraftOption
  index: number
  onSelect: (option: DraftOption, index: number) => void
}) {
  const config = labelConfig[option.label]
  const hasRiskFlags = option.riskFlags.length > 0

  return (
    <button
      type="button"
      onClick={() => onSelect(option, index)}
      className={cn(
        "w-full text-left p-3 rounded-lg border bg-card hover:bg-accent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="secondary" className={cn("text-xs font-medium", config.colorClass)}>
              {config.label}
            </Badge>
            {hasRiskFlags && (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            )}
          </div>
          <p className="text-sm text-foreground line-clamp-2">{option.text}</p>
        </div>
      </div>
      {hasRiskFlags && (
        <div className="mt-2 pt-2 border-t">
          {option.riskFlags.slice(0, 2).map((flag, i) => (
            <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
              {flag.type}: &quot;{flag.trigger}&quot;
            </p>
          ))}
        </div>
      )}
    </button>
  )
}

export const MessageResponseCard = React.forwardRef<
  MessageResponseCardRef,
  MessageResponseCardProps
>(function MessageResponseCard(
  {
    personName,
    messageTimestamp,
    messages,
    responseText,
    onResponseChange,
    className,
    autoFocus = true,
    platform,
    availablePlatforms,
    onPlatformChange,
    draftOptions,
    onOptionSelect,
    riskLevel,
    requiresApproval,
  },
  ref
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const [showOptions, setShowOptions] = React.useState(true)

  // Handle option selection: populate textarea and hide options
  const handleOptionSelect = React.useCallback(
    (option: DraftOption, index: number) => {
      onResponseChange(option.text)
      setShowOptions(false)
      onOptionSelect?.(option, index)
      // Auto-focus the textarea after selecting
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 100)
    },
    [onResponseChange, onOptionSelect]
  )

  // Show options again if text is cleared
  React.useEffect(() => {
    if (responseText === "" && draftOptions && draftOptions.length > 0) {
      setShowOptions(true)
    }
  }, [responseText, draftOptions])

  React.useImperativeHandle(ref, () => ({
    focusInput: () => {
      textareaRef.current?.focus()
    },
  }))

  React.useEffect(() => {
    if (!autoFocus) return
    const timer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 300)
    return () => clearTimeout(timer)
  }, [autoFocus])

  // Scroll to bottom on initial load
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop =
          scrollContainerRef.current.scrollHeight
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [messages])

  const initials = getInitials(personName)

  // Sort messages chronologically (oldest first)
  const sortedMessages = React.useMemo(
    () => [...messages].sort((a, b) => a.sentAt - b.sentAt),
    [messages]
  )

  return (
    <Card
      className={cn(
        "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0",
        className
      )}
    >
      {/* Header */}
      <CardHeader className="shrink-0 p-4">
        <div className="flex items-center gap-x-3">
          <Avatar size="sm">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-foreground truncate">
              {personName}
            </h3>
            {messageTimestamp && (
              <p className="text-xs text-muted-foreground">
                {formatRelativeTime(messageTimestamp)}
              </p>
            )}
          </div>

          {/* Platform Selector */}
          {platform && availablePlatforms && availablePlatforms.length > 1 && onPlatformChange ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/60 hover:bg-muted text-sm transition-colors">
                <span className={platformConfig[platform].colorClass}>
                  {platformConfig[platform].icon}
                </span>
                <span className="text-xs font-medium">{platformConfig[platform].label}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {availablePlatforms.map((p) => (
                  <DropdownMenuItem
                    key={p}
                    onClick={() => onPlatformChange(p)}
                    className={cn(
                      "flex items-center gap-2",
                      p === platform && "bg-muted"
                    )}
                  >
                    <span className={platformConfig[p].colorClass}>
                      {platformConfig[p].icon}
                    </span>
                    <span>{platformConfig[p].label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : platform ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/60 text-sm">
              <span className={platformConfig[platform].colorClass}>
                {platformConfig[platform].icon}
              </span>
              <span className="text-xs font-medium">{platformConfig[platform].label}</span>
            </div>
          ) : null}
        </div>
      </CardHeader>

      {/* Message Context */}
      <CardContent className="flex-1 p-0 min-h-0">
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
          style={{ scrollbarColor: "rgba(128, 128, 128, 0.5) transparent" }}
        >
          <div className="py-4 px-4 space-y-2">
            {sortedMessages.length > 0 ? (
              sortedMessages.map((msg) => {
                const hasReactions = msg.reactions && msg.reactions.length > 0
                const hasAttachments =
                  msg.attachments && msg.attachments.length > 0
                const hasText =
                  msg.content &&
                  msg.content.trim().length > 0 &&
                  !(hasAttachments && msg.content.trim() === "[attachment]")

                return (
                  <div
                    key={msg._id}
                    className={cn(
                      "flex flex-col w-full",
                      msg.isFromMe ? "items-end" : "items-start",
                      hasReactions && "mb-2"
                    )}
                  >
                    {!msg.isFromMe && msg.senderName && (
                      <p className="text-xs font-medium opacity-70 mb-1 ml-1">
                        {msg.senderName}
                      </p>
                    )}
                    <div
                      className={cn(
                        "flex w-full",
                        msg.isFromMe ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "relative rounded-2xl px-4 py-2 text-sm break-words",
                          msg.isFromMe
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground"
                        )}
                        style={{ maxWidth: "85%", width: "fit-content" }}
                      >
                        {hasReactions && (
                          <ReactionBadges
                            reactions={msg.reactions!}
                            isSent={msg.isFromMe}
                          />
                        )}
                        {hasAttachments && (
                          <AttachmentDisplay attachments={msg.attachments!} />
                        )}
                        {hasText && msg.content && (
                          <p
                            className="whitespace-pre-wrap break-words select-text"
                            data-selectable="true"
                          >
                            {msg.content}
                          </p>
                        )}
                        {!hasText && !hasAttachments && (
                          <p className="whitespace-pre-wrap break-words">
                            [No text]
                          </p>
                        )}
                        <p
                          className={cn(
                            "text-[10px] opacity-60 mt-1 flex items-center gap-1",
                            msg.isFromMe ? "justify-end" : "justify-start"
                          )}
                        >
                          {formatTime(msg.sentAt)}
                          {msg.isFromMe && (
                            <>
                              <span className="mx-0.5">·</span>
                              <DeliveryStatus status={msg.status} />
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <p>No recent messages</p>
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {/* Draft Options */}
      {draftOptions && draftOptions.length > 0 && showOptions && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Suggested replies</span>
          </div>
          <div className="space-y-2">
            {draftOptions.map((option, index) => (
              <DraftOptionButton
                key={index}
                option={option}
                index={index}
                onSelect={handleOptionSelect}
              />
            ))}
          </div>
        </div>
      )}

      {/* Risk Warning */}
      {riskLevel && riskLevel !== "low" && (
        <div className={cn(
          "mx-4 mb-2 px-3 py-2 rounded-lg text-xs flex items-center gap-2",
          riskLevel === "high"
            ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        )}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {riskLevel === "high"
              ? "Review carefully before sending"
              : "Contains commitment or sensitive content"}
          </span>
        </div>
      )}

      {/* Response Input */}
      <CardFooter className="p-4 bg-transparent" data-selectable="true">
        <Textarea
          ref={textareaRef}
          value={responseText}
          onChange={(e) => onResponseChange(e.target.value)}
          placeholder={draftOptions && draftOptions.length > 0
            ? "Select an option above or type your own..."
            : "Type your response... (swipe right to send)"}
          className="min-h-[80px] max-h-[150px] resize-none bg-background w-full"
          onKeyDown={(e) => {
            // Prevent card swipe while typing
            e.stopPropagation()
          }}
        />
      </CardFooter>
    </Card>
  )
})

export default MessageResponseCard

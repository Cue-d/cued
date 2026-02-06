import * as React from "react"
import { motion } from "motion/react"
import {
  ChevronRight,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react"
import { MentionText, hasMentions } from "./mention-text"
import { ToolArtifact } from "./tool-artifact"
import { cn } from "../../lib/utils"
import { Loader } from "../ai-elements/loader"
import { MessageResponse } from "../ai-elements/message"
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../ai-elements/reasoning"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible"

export interface ToolInvocation {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  state: "partial-call" | "call" | "result"
  result?: unknown
}

export interface AssistantMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt?: Date
}

export interface MessageWithToolInvocations extends AssistantMessage {
  toolInvocations?: ToolInvocation[]
  reasoning?: string
}

interface ChatMessageProps {
  message: MessageWithToolInvocations
  isStreaming?: boolean
  className?: string
}

// ---------------------------------------------------------------------------
// Size configuration (matches Craft Agents TurnCard sizing)
// ---------------------------------------------------------------------------

const SIZE_CONFIG = {
  fontSize: "text-[13px]",
  iconSize: "w-3 h-3",
  spinnerSize: 10,
} as const

const MAX_RESPONSE_HEIGHT = 540
const EMPTY_TOOL_INVOCATIONS: ToolInvocation[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToolDisplayName(name: string): string {
  return name.replace(/_/g, " ")
}

function getPreviewText(
  toolInvocations: ToolInvocation[] | undefined,
  isStreaming: boolean,
  hasContent: boolean
): string {
  if (!toolInvocations?.length) return isStreaming ? "Thinking..." : "Completed"

  const running = toolInvocations.filter(
    (t) => t.state === "call" || t.state === "partial-call"
  )

  if (isStreaming && hasContent) return "Responding..."

  if (running.length > 0) {
    const names = running
      .map((t) => getToolDisplayName(t.toolName))
      .slice(0, 3)
    return `${names.join(", ")}...`
  }

  return "Steps completed"
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Status icon for a tool invocation — spinner when active, check/x when done */
function ToolStatusIcon({ invocation }: { invocation: ToolInvocation }) {
  switch (invocation.state) {
    case "partial-call":
    case "call":
      return (
        <div
          className={cn(
            SIZE_CONFIG.iconSize,
            "flex items-center justify-center shrink-0"
          )}
        >
          <Loader size={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case "result":
      return (
        <CheckCircle2
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")}
        />
      )
    default:
      return (
        <CheckCircle2
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")}
        />
      )
  }
}

/** Single tool call row in the activity list */
function ActivityRow({ invocation }: { invocation: ToolInvocation }) {
  const displayName = getToolDisplayName(invocation.toolName)
  const description = invocation.args?.description as string | undefined

  return (
    <div
      className={cn(
        "flex items-center gap-2 py-0.5 text-muted-foreground",
        SIZE_CONFIG.fontSize
      )}
    >
      <ToolStatusIcon invocation={invocation} />
      <span className="shrink-0">{displayName}</span>
      {description && (
        <>
          <span className="opacity-60">·</span>
          <span className="truncate flex-1 min-w-0">{description}</span>
        </>
      )}
    </div>
  )
}

/** Collapsible activity section with tool calls */
function ActivitySection({
  toolInvocations,
  isStreaming,
  hasContent,
}: {
  toolInvocations: ToolInvocation[]
  isStreaming: boolean
  hasContent: boolean
}) {
  const [isExpanded, setIsExpanded] = React.useState(false)

  const pendingCount = toolInvocations.filter(
    (t) => t.state === "call" || t.state === "partial-call"
  ).length

  const previewText = getPreviewText(toolInvocations, isStreaming, hasContent)

  return (
    <div className="select-none">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger
          className={cn(
            "flex items-center gap-2 w-full pl-2.5 pr-1.5 py-1.5 rounded-[8px] text-left",
            SIZE_CONFIG.fontSize,
            "text-muted-foreground",
            "hover:bg-muted/50 transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          {/* Chevron */}
          <ChevronRight
            className={cn(
              SIZE_CONFIG.iconSize,
              "shrink-0 transition-transform duration-150",
              isExpanded && "rotate-90"
            )}
          />

          {/* Step count badge */}
          <span className="-ml-0.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium tabular-nums">
            {toolInvocations.length}
          </span>

          {/* Preview text */}
          <span className="truncate flex-1 min-w-0">{previewText}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="pl-4 pr-2 space-y-0.5 border-l-2 border-muted ml-[13px]">
            {toolInvocations.map((inv, index) => (
              <motion.div
                key={inv.toolCallId}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index < 10 ? index * 0.03 : 0.3 }}
              >
                <ActivityRow invocation={inv} />
              </motion.div>
            ))}

            {/* Thinking indicator inside expanded activity list */}
            {isStreaming && pendingCount > 0 && (
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: toolInvocations.length * 0.03 }}
                className={cn(
                  "flex items-center gap-2 py-0.5 text-muted-foreground/70",
                  SIZE_CONFIG.fontSize
                )}
              >
                <div
                  className={cn(
                    SIZE_CONFIG.iconSize,
                    "flex items-center justify-center shrink-0"
                  )}
                >
                  <Loader size={SIZE_CONFIG.spinnerSize} />
                </div>
                <span>Thinking...</span>
              </motion.div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** Card displaying the assistant's markdown response */
function ResponseCard({
  content,
  isStreaming,
}: {
  content: string
  isStreaming: boolean
}) {
  const [copied, setCopied] = React.useState(false)
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  React.useEffect(() => {
    return () => clearTimeout(copyTimerRef.current)
  }, [])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }, [content])

  return (
    <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden">
      {/* Scrollable content */}
      <div
        className="pl-[22px] pr-4 py-3 text-sm overflow-y-auto"
        style={{ maxHeight: MAX_RESPONSE_HEIGHT }}
      >
        <MessageResponse className="text-[15px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {content}
        </MessageResponse>
      </div>

      {/* Footer */}
      <div
        className={cn(
          "px-4 py-2 border-t border-border/30 flex items-center bg-muted/20",
          SIZE_CONFIG.fontSize
        )}
      >
        {isStreaming ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader size={SIZE_CONFIG.spinnerSize} />
            <span>Streaming...</span>
          </div>
        ) : (
          <button
            onClick={handleCopy}
            className={cn(
              "flex items-center gap-1.5 transition-colors select-none",
              copied
                ? "text-success"
                : "text-muted-foreground hover:text-foreground",
              "focus:outline-none focus-visible:underline"
            )}
          >
            {copied ? (
              <>
                <Check className={SIZE_CONFIG.iconSize} />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className={SIZE_CONFIG.iconSize} />
                <span>Copy</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ChatMessage component
// ---------------------------------------------------------------------------

export function ChatMessage({
  message,
  isStreaming = false,
  className,
}: ChatMessageProps) {
  const isUser = message.role === "user"

  const allToolCalls = message.toolInvocations ?? EMPTY_TOOL_INVOCATIONS
  const completedToolCalls = React.useMemo(
    () =>
      allToolCalls.filter(
        (inv) => inv.state === "result" && inv.result !== undefined
      ),
    [allToolCalls]
  )
  const hasToolCalls = allToolCalls.length > 0

  // ── User message ──────────────────────────────────────────────────────
  if (isUser) {
    return (
      <div className={cn("flex flex-col items-end w-full", className)}>
        <div className="max-w-[80%] bg-foreground/5 rounded-[16px] px-5 py-3.5 select-text [&_p]:m-0">
          {hasMentions(message.content) ? (
            <p className="text-sm">
              <MentionText text={message.content} />
            </p>
          ) : (
            <MessageResponse className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {message.content}
            </MessageResponse>
          )}
        </div>
      </div>
    )
  }

  // ── Assistant message ─────────────────────────────────────────────────
  return (
    <div className={cn("w-full space-y-1", className)}>
      {/* Reasoning / thinking section */}
      {message.reasoning && (
        <Reasoning isStreaming={isStreaming && !message.content}>
          <ReasoningTrigger />
          <ReasoningContent>{message.reasoning}</ReasoningContent>
        </Reasoning>
      )}

      {/* Activity section — collapsible tool calls */}
      {hasToolCalls && (
        <ActivitySection
          toolInvocations={allToolCalls}
          isStreaming={isStreaming}
          hasContent={!!message.content}
        />
      )}

      {/* Standalone thinking indicator — no tools, no content yet */}
      {!hasToolCalls && isStreaming && !message.content && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-muted-foreground",
            SIZE_CONFIG.fontSize
          )}
        >
          <Loader size={SIZE_CONFIG.spinnerSize} />
          <span>Thinking...</span>
        </div>
      )}

      {/* Response card */}
      {message.content && (
        <div className={hasToolCalls ? "mt-2" : undefined}>
          <ResponseCard
            content={message.content}
            isStreaming={isStreaming}
          />
        </div>
      )}

      {/* Tool artifacts (search results, contacts, etc.) */}
      {completedToolCalls.length > 0 && (
        <div className="w-full max-w-md mt-2">
          {completedToolCalls.length === 1 ? (
            <ToolArtifact
              toolName={completedToolCalls[0].toolName}
              result={completedToolCalls[0].result}
            />
          ) : (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRight className="size-3.5" />
                <span>{completedToolCalls.length} tool results</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-3">
                {completedToolCalls.map((inv) => (
                  <ToolArtifact
                    key={inv.toolCallId}
                    toolName={inv.toolName}
                    result={inv.result}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}
    </div>
  )
}

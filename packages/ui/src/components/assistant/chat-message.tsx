import * as React from "react"
import { Bot, ChevronDown, User } from "lucide-react"
import { MentionText, hasMentions } from "./mention-text"
import { ToolArtifact } from "./tool-artifact"
import { cn } from "../../lib/utils"
import { Loader } from "../ai-elements/loader"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message"
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../ai-elements/reasoning"
import { Avatar, AvatarFallback } from "../ui/avatar"
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

function StreamingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Loader size={14} />
    </span>
  )
}

function ToolCallIndicator({ toolName }: { toolName: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader size={12} />
      <span>Using {toolName.replace(/_/g, " ")}...</span>
    </div>
  )
}

export function ChatMessage({
  message,
  isStreaming = false,
  className,
}: ChatMessageProps) {
  const isUser = message.role === "user"
  const [showToolCalls, setShowToolCalls] = React.useState(false)

  // Get completed tool invocations with results
  const completedToolCalls = React.useMemo(() => {
    if (!message.toolInvocations) return []
    return message.toolInvocations.filter(
      (inv) => inv.state === "result" && inv.result !== undefined
    )
  }, [message.toolInvocations])

  // Get pending tool calls
  const pendingToolCalls = message.toolInvocations?.filter(
    (inv) => inv.state === "call" || inv.state === "partial-call"
  )

  return (
    <Message from={message.role} className={className}>
      <div
        className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}
      >
        <Avatar
          size="sm"
          className="mt-0.5 shrink-0 transition-transform duration-200 group-hover:scale-105"
        >
          <AvatarFallback
            className={cn(
              "text-xs ring-2 ring-background",
              isUser
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            )}
          >
            {isUser ? (
              <User className="size-3.5" />
            ) : (
              <Bot className="size-3.5" />
            )}
          </AvatarFallback>
        </Avatar>

        <div
          className={cn(
            "flex max-w-[85%] flex-col gap-2",
            isUser ? "items-end" : "items-start"
          )}
        >
          {/* Reasoning content (for thinking models) */}
          {!isUser && message.reasoning && (
            <Reasoning isStreaming={isStreaming && !message.content}>
              <ReasoningTrigger />
              <ReasoningContent>{message.reasoning}</ReasoningContent>
            </Reasoning>
          )}

          <MessageContent
            className={cn(
              "rounded-2xl px-4 py-3",
              isUser
                ? "rounded-br-md bg-primary text-primary-foreground"
                : "rounded-bl-md bg-muted/60 text-foreground backdrop-blur-sm border border-border/30"
            )}
          >
            {message.content ? (
              isUser ? (
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
                  {hasMentions(message.content) ? (
                    <MentionText text={message.content} />
                  ) : (
                    message.content
                  )}
                </p>
              ) : (
                <MessageResponse className="text-[15px] leading-relaxed">
                  {message.content}
                </MessageResponse>
              )
            ) : isStreaming ? (
              <StreamingIndicator />
            ) : null}
          </MessageContent>

          {/* Pending tool calls */}
          {pendingToolCalls && pendingToolCalls.length > 0 && (
            <div className="space-y-1">
              {pendingToolCalls.map((inv) => (
                <ToolCallIndicator
                  key={inv.toolCallId}
                  toolName={inv.toolName}
                />
              ))}
            </div>
          )}

          {/* Completed tool results */}
          {completedToolCalls.length > 0 && (
            <div className="w-full max-w-md">
              {completedToolCalls.length === 1 ? (
                <ToolArtifact
                  toolName={completedToolCalls[0].toolName}
                  result={completedToolCalls[0].result}
                />
              ) : (
                <Collapsible
                  open={showToolCalls}
                  onOpenChange={setShowToolCalls}
                >
                  <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform duration-200",
                        showToolCalls && "rotate-180"
                      )}
                    />
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
      </div>
    </Message>
  )
}

import * as React from "react";
import { Bot, ChevronDown, Loader2, User } from "lucide-react";

import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback } from "../ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { ToolArtifact } from "./tool-artifact";
import type {
  MessageWithToolInvocations,
  ToolArtifact as ToolArtifactType,
} from "./types";

interface ChatMessageProps {
  message: MessageWithToolInvocations;
  isStreaming?: boolean;
  className?: string;
}

function parseToolResult(
  toolName: string,
  result: unknown
): ToolArtifactType | null {
  if (!result || typeof result !== "object") return null;

  const data = result as Record<string, unknown>;
  if (!data.success) return null;

  switch (toolName) {
    case "search_messages":
      if (Array.isArray(data.results)) {
        return { type: "search_results", data: data.results };
      }
      break;
    case "search_contacts":
      if (Array.isArray(data.contacts)) {
        return { type: "contacts", data: data.contacts };
      }
      break;
    case "get_conversations":
      if (Array.isArray(data.conversations)) {
        return { type: "conversations", data: data.conversations };
      }
      break;
    case "create_action":
      if (data.actionId) {
        return {
          type: "action_created",
          data: {
            actionId: data.actionId as string,
            type: (data.type as string) || "unknown",
            priority: (data.priority as number) || 50,
            reason: data.reason as string | undefined,
            draftMessage: data.draftMessage as string | undefined,
          },
        };
      }
      break;
    case "search_memories":
      if (Array.isArray(data.memories)) {
        return { type: "memories", data: data.memories };
      }
      break;
  }

  return null;
}

function StreamingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current" />
    </span>
  );
}

function ToolCallIndicator({ toolName }: { toolName: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      <span>Using {toolName.replace(/_/g, " ")}...</span>
    </div>
  );
}

export function ChatMessage({
  message,
  isStreaming = false,
  className,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [showToolCalls, setShowToolCalls] = React.useState(false);

  const artifacts = React.useMemo(() => {
    if (!message.toolInvocations) return [];
    return message.toolInvocations
      .filter((inv) => inv.state === "result" && inv.result)
      .map((inv) => parseToolResult(inv.toolName, inv.result))
      .filter((a): a is ToolArtifactType => a !== null);
  }, [message.toolInvocations]);

  const pendingToolCalls = message.toolInvocations?.filter(
    (inv) => inv.state === "call" || inv.state === "partial-call"
  );

  return (
    <div
      className={cn(
        "group flex gap-3.5",
        isUser ? "flex-row-reverse" : "flex-row",
        className
      )}
    >
      <Avatar
        size="sm"
        className="mt-1 shrink-0 transition-transform duration-200 group-hover:scale-105"
      >
        <AvatarFallback
          className={cn(
            "text-xs ring-2 ring-background",
            isUser
              ? "bg-linear-to-br from-primary to-primary/80 text-primary-foreground shadow-md shadow-primary/20"
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
          "flex max-w-[85%] flex-col",
          isUser ? "items-end" : "items-start"
        )}
      >
        <div
          className={cn(
            "rounded-2xl px-4 py-3",
            isUser
              ? "rounded-br-lg bg-linear-to-br from-primary to-primary/90 text-primary-foreground shadow-lg shadow-primary/15"
              : "rounded-bl-lg bg-muted/60 text-foreground backdrop-blur-sm border border-border/30"
          )}
        >
          {message.content ? (
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
              {message.content}
              {isStreaming && !message.content.trim() && <StreamingDots />}
            </p>
          ) : isStreaming ? (
            <StreamingDots />
          ) : null}
        </div>

        {pendingToolCalls && pendingToolCalls.length > 0 && (
          <div className="mt-2">
            {pendingToolCalls.map((inv) => (
              <ToolCallIndicator key={inv.toolCallId} toolName={inv.toolName} />
            ))}
          </div>
        )}

        {artifacts.length > 0 && (
          <div className="mt-3 w-full max-w-md">
            {artifacts.length === 1 ? (
              <ToolArtifact artifact={artifacts[0]} />
            ) : (
              <Collapsible open={showToolCalls} onOpenChange={setShowToolCalls}>
                <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform duration-200",
                      showToolCalls && "rotate-180"
                    )}
                  />
                  <span>{artifacts.length} tool results</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 space-y-3">
                  {artifacts.map((artifact, i) => (
                    <ToolArtifact key={i} artifact={artifact} />
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

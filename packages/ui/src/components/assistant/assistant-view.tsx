import * as React from "react"
import { Sparkles } from "lucide-react"

import { cn } from "../../lib/utils"
import { ChatInput } from "./chat-input"
import { ChatMessage } from "./chat-message"
import { SuggestedPrompts } from "./suggested-prompts"
import type { MessageWithToolInvocations, SuggestedPrompt } from "./types"

interface AssistantViewProps {
  messages: MessageWithToolInvocations[]
  input: string
  onInputChange: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  isLoading?: boolean
  error?: Error | null
  suggestedPrompts?: SuggestedPrompt[]
  className?: string
}

export function AssistantView({
  messages,
  input,
  onInputChange,
  onSubmit,
  onStop,
  isLoading = false,
  error,
  suggestedPrompts,
  className,
}: AssistantViewProps) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" })
  }, [messages, isLoading])

  const isEmpty = messages.length === 0

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="relative mb-6">
                <div className="absolute inset-0 animate-pulse rounded-full bg-primary/20 blur-xl" />
                <div className="relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/80 to-primary text-primary-foreground shadow-lg">
                  <Sparkles className="size-8" />
                </div>
              </div>

              <h2 className="mb-2 text-xl font-semibold tracking-tight text-foreground">
                Personal Assistant
              </h2>
              <p className="mb-8 max-w-sm text-center text-sm text-muted-foreground">
                Ask about your conversations, contacts, and relationships. I can
                search messages, create follow-ups, and help you stay connected.
              </p>

              <SuggestedPrompts
                onSelect={onInputChange}
                prompts={suggestedPrompts}
                className="w-full max-w-md"
              />
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message, index) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isStreaming={
                    isLoading &&
                    message.role === "assistant" &&
                    index === messages.length - 1
                  }
                />
              ))}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error.message || "Something went wrong. Please try again."}
            </div>
          )}
        </div>
      </div>

      <div className="border-t bg-background/80 px-4 py-4 backdrop-blur-sm">
        <div className="mx-auto max-w-2xl">
          <ChatInput
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            onStop={onStop}
            isLoading={isLoading}
          />
        </div>
      </div>
    </div>
  )
}

import * as React from "react";
import { Sparkles } from "lucide-react";

import { cn } from "../../lib/utils";
import { type Attachment, MultimodalInput } from "./multimodal-input";
import { ChatMessage } from "./chat-message";
import { SuggestedPrompts } from "./suggested-prompts";
import type { MessageWithToolInvocations, SuggestedPrompt } from "./types";

interface AssistantViewProps {
  messages: MessageWithToolInvocations[];
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isLoading?: boolean;
  error?: Error | null;
  suggestedPrompts?: SuggestedPrompt[];
  attachments?: Attachment[];
  onAttachmentsChange?: React.Dispatch<React.SetStateAction<Attachment[]>>;
  className?: string;
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
  attachments = [],
  onAttachmentsChange,
  className,
}: AssistantViewProps) {
  // Internal attachments state for when not controlled externally
  const [internalAttachments, setInternalAttachments] = React.useState<
    Attachment[]
  >([]);
  const actualAttachments = onAttachmentsChange
    ? attachments
    : internalAttachments;
  const setActualAttachments = onAttachmentsChange ?? setInternalAttachments;
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);

  const isEmpty = messages.length === 0;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-8">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="relative mb-8">
                <div className="absolute inset-0 scale-150 rounded-full bg-primary/10 blur-3xl" />
                <div className="absolute inset-0 scale-125 animate-pulse rounded-full bg-primary/20 blur-xl" />
                <div className="relative flex size-20 items-center justify-center rounded-3xl from-primary via-primary to-primary/80 text-primary-foreground shadow-xl shadow-primary/25 ring-1 ring-white/10">
                  <Sparkles className="size-9" strokeWidth={1.5} />
                </div>
              </div>

              {/* Typography with editorial feel */}
              <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
                Personal Assistant
              </h2>
              <p className="mb-10 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                Ask about your conversations, contacts, and relationships. I can
                search messages, create follow-ups, and help you stay connected.
              </p>

              <SuggestedPrompts
                onSelect={onInputChange}
                prompts={suggestedPrompts}
                className="w-full max-w-lg"
              />
            </div>
          ) : (
            <div className="space-y-8">
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
            <div className="mt-6 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive backdrop-blur-sm">
              {error.message || "Something went wrong. Please try again."}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/50 bg-background/90 px-4 py-5 backdrop-blur-md">
        <div className="mx-auto max-w-2xl">
          <MultimodalInput
            input={input}
            setInput={(value) => {
              if (typeof value === "function") {
                onInputChange(value(input));
              } else {
                onInputChange(value);
              }
            }}
            onSubmit={onSubmit}
            onStop={onStop}
            isSubmitting={isLoading}
            attachments={actualAttachments}
            setAttachments={setActualAttachments}
          />
        </div>
      </div>
    </div>
  );
}

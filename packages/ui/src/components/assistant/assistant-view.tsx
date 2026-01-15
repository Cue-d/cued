import * as React from "react";
import { Sparkles } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import { type Attachment, MultimodalInput } from "./multimodal-input";
import { ChatMessage } from "./chat-message";
import { Suggestions, Suggestion } from "../ai-elements/suggestion";
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

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  {
    title: "Who did I talk to recently?",
    prompt: "Who did I talk to recently?",
  },
  {
    title: "Any messages I should reply to?",
    prompt: "Are there any messages I should reply to?",
  },
  {
    title: "What's new with my contacts?",
    prompt: "What's new with my contacts?",
  },
];

export function AssistantView({
  messages,
  input,
  onInputChange,
  onSubmit,
  onStop,
  isLoading = false,
  error,
  suggestedPrompts = DEFAULT_PROMPTS,
  attachments = [],
  onAttachmentsChange,
  className,
}: AssistantViewProps) {
  const [internalAttachments, setInternalAttachments] = React.useState<
    Attachment[]
  >([]);
  const actualAttachments = onAttachmentsChange
    ? attachments
    : internalAttachments;
  const setActualAttachments = onAttachmentsChange ?? setInternalAttachments;

  const isEmpty = messages.length === 0;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto max-w-2xl gap-6 px-4 py-8">
          {isEmpty ? (
            <ConversationEmptyState className="py-16">
              <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
                Personal Assistant
              </h2>
              <p className="mb-8 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                Ask about your conversations, contacts, and relationships. I can
                search messages, create follow-ups, and help you stay connected.
              </p>

              <Suggestions className="justify-center">
                {suggestedPrompts.map((prompt) => (
                  <Suggestion
                    key={prompt.title}
                    suggestion={prompt.prompt}
                    onClick={onInputChange}
                    className="bg-muted/50 hover:bg-muted"
                  >
                    {prompt.title}
                  </Suggestion>
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : (
            <>
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
            </>
          )}

          {error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive backdrop-blur-sm">
              {error.message || "Something went wrong. Please try again."}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border/50 bg-background/95 px-4 py-5 backdrop-blur-xl">
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

import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { ChatMessage } from "./chat-message";
import { cn } from "../../lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
  PromptInputButton,
  PromptInputAttachments,
  PromptInputAttachment,
  usePromptInputAttachments,
} from "../ai-elements/prompt-input";
import { Suggestions, Suggestion } from "../ai-elements/suggestion";
import type { MentionSearchResult } from "./mention-types";
import type { MessageWithToolInvocations, SuggestedPrompt } from "./types";

function AttachmentButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton onClick={() => attachments.openFileDialog()}>
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}

interface AssistantViewProps {
  messages: MessageWithToolInvocations[];
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isLoading?: boolean;
  error?: Error | null;
  suggestedPrompts?: SuggestedPrompt[];
  className?: string;
  /** Function to search contacts for @mentions */
  searchContacts?: (query: string) => Promise<MentionSearchResult[]>;
  /** Called when a mention is inserted in the input */
  onMentionInsert?: (contact: MentionSearchResult) => void;
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
  className,
  searchContacts,
  onMentionInsert,
}: AssistantViewProps) {
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
            messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                isStreaming={
                  isLoading &&
                  message.role === "assistant" &&
                  index === messages.length - 1
                }
              />
            ))
          )}

          {error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive backdrop-blur-sm">
              {error.message || "Something went wrong. Please try again."}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="p-2">
        <div className="mx-auto max-w-2xl">
          <PromptInput
            accept="image/*"
            className="border border-border/60 bg-background/80 rounded-lg backdrop-blur-sm transition-all focus-within:border-primary/40 focus-within:shadow-md focus-within:shadow-primary/5 [&>[data-slot=input-group]]:border-0 [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:bg-transparent"
            multiple
            onSubmit={(message) => {
              if (!message.text.trim() && message.files.length === 0) return;
              onSubmit();
            }}
          >
            <PromptInputAttachments>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
            <PromptInputTextarea
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder="Ask about your conversations..."
              className="min-h-12"
              searchContacts={searchContacts}
              onMentionInsert={onMentionInsert}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <AttachmentButton />
              </PromptInputTools>
              {isLoading ? (
                <PromptInputButton onClick={onStop} variant="default">
                  <SquareIcon className="size-4" />
                </PromptInputButton>
              ) : (
                <PromptInputSubmit disabled={!input.trim()}>
                  <ArrowUpIcon className="size-4" />
                </PromptInputSubmit>
              )}
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

import { cn } from "../../lib/utils";
import { Suggestions, Suggestion } from "../ai-elements/suggestion";
import type { SuggestedPrompt } from "./types";

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  {
    title: "Recent conversations",
    prompt: "What conversations have I had this week?",
  },
  {
    title: "Unanswered messages",
    prompt: "Show me messages I haven't responded to",
  },
  { title: "Search messages", prompt: "Search for messages about " },
  { title: "Find contact", prompt: "Find information about " },
];

interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void;
  prompts?: SuggestedPrompt[];
  className?: string;
}

export function SuggestedPrompts({
  onSelect,
  prompts = DEFAULT_PROMPTS,
  className,
}: SuggestedPromptsProps) {
  return (
    <Suggestions className={cn("flex-wrap justify-center gap-2", className)}>
      {prompts.map((prompt) => (
        <Suggestion
          key={prompt.title}
          suggestion={prompt.prompt}
          onClick={onSelect}
          className="bg-muted/50 hover:bg-muted"
        >
          {prompt.title}
        </Suggestion>
      ))}
    </Suggestions>
  );
}

import * as React from "react"
import { Clock, MessageSquare, Search, UserPlus } from "lucide-react"

import { cn } from "../../lib/utils"
import type { SuggestedPrompt } from "./types"

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  {
    icon: <Clock className="size-4" />,
    label: "Recent conversations",
    prompt: "What conversations have I had this week?",
  },
  {
    icon: <MessageSquare className="size-4" />,
    label: "Unanswered messages",
    prompt: "Show me messages I haven't responded to",
  },
  {
    icon: <Search className="size-4" />,
    label: "Search messages",
    prompt: "Search for messages about ",
  },
  {
    icon: <UserPlus className="size-4" />,
    label: "Find contact",
    prompt: "Find information about ",
  },
]

interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void
  prompts?: SuggestedPrompt[]
  className?: string
}

export function SuggestedPrompts({
  onSelect,
  prompts = DEFAULT_PROMPTS,
  className,
}: SuggestedPromptsProps) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", className)}>
      {prompts.map((prompt, index) => (
        <button
          key={prompt.label}
          type="button"
          onClick={() => onSelect(prompt.prompt)}
          className={cn(
            "group relative flex items-center gap-3 rounded-xl border border-border/40 bg-card/50 px-4 py-3.5 text-left transition-all",
            "hover:border-primary/30 hover:bg-card hover:shadow-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            "animate-in fade-in slide-in-from-bottom-2"
          )}
          style={{ animationDelay: `${index * 75}ms`, animationFillMode: "backwards" }}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            {prompt.icon}
          </div>
          <span className="text-sm font-medium text-foreground/80 group-hover:text-foreground">
            {prompt.label}
          </span>
        </button>
      ))}
    </div>
  )
}

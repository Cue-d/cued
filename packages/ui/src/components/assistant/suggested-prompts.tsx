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
            "group relative flex items-center gap-3.5 rounded-2xl border border-border/30 bg-card/40 px-4 py-4 text-left",
            "transition-all duration-300 ease-out",
            "hover:border-primary/40 hover:bg-card/80 hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-0.5",
            "active:scale-[0.98] active:translate-y-0",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "animate-in fade-in slide-in-from-bottom-3"
          )}
          style={{ animationDelay: `${index * 100}ms`, animationFillMode: "backwards" }}
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 text-primary transition-all duration-300 group-hover:from-primary/25 group-hover:to-primary/10 group-hover:scale-110">
            {prompt.icon}
          </div>
          <span className="text-sm font-medium text-foreground/70 transition-colors duration-200 group-hover:text-foreground">
            {prompt.label}
          </span>
        </button>
      ))}
    </div>
  )
}

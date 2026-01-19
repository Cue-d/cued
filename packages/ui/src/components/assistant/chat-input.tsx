import * as React from "react"
import { SendHorizonal, Square } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  isLoading?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading = false,
  disabled = false,
  placeholder = "Ask about your conversations...",
  className,
}: ChatInputProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }, [value])

  React.useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && !isLoading && value.trim()) {
        onSubmit()
      }
    }
  }

  function handleButtonClick() {
    if (isLoading && onStop) {
      onStop()
    } else if (value.trim()) {
      onSubmit()
    }
  }

  const canSubmit = value.trim().length > 0 && !disabled

  return (
    <div className={cn("relative", className)}>
      <div className="relative flex items-end gap-2 rounded-2xl border border-border/60 bg-background/80 px-4 py-3 shadow-sm backdrop-blur-sm transition-all focus-within:border-primary/40 focus-within:shadow-md focus-within:shadow-primary/5">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-transparent text-[15px] leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ minHeight: "24px", maxHeight: "160px" }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant={isLoading ? "destructive" : "default"}
          disabled={!isLoading && !canSubmit}
          onClick={handleButtonClick}
          className={cn("shrink-0 transition-all", isLoading && "animate-pulse")}
        >
          {isLoading ? (
            <Square className="size-3.5 fill-current" />
          ) : (
            <SendHorizonal className="size-4" />
          )}
        </Button>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground/50">
        Press Enter to send, Shift+Enter for new line
      </p>
    </div>
  )
}

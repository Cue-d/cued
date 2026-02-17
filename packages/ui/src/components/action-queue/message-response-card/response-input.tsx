"use client"

import * as React from "react"
import { ArrowUp } from 'lucide-react'
import { cn } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { Textarea } from "../../ui/textarea"

export interface ResponseInputProps {
  /** Current response text */
  value: string
  /** Called when response text changes */
  onChange: (text: string) => void
  /** Called when user triggers send (Enter key or button click) */
  onSend?: () => void
  /** Whether a send is in progress */
  isSending?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Ref to the underlying textarea */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}

const DEFAULT_PLACEHOLDER = "Send a message..."

/**
 * ResponseInput component - textarea for composing message responses.
 * Enter sends, Shift+Enter for newline. Includes send button.
 */
export function ResponseInput({
  value,
  onChange,
  onSend,
  isSending = false,
  placeholder = DEFAULT_PLACEHOLDER,
  textareaRef,
}: ResponseInputProps): React.ReactElement {
  const canSend = value.trim().length > 0 && !isSending

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Enter" && !e.shiftKey && onSend && canSend) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="relative w-full">
      <Textarea
        ref={textareaRef}
        data-response-input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[80px] max-h-[150px] resize-none bg-muted/50 w-full pr-12"
        onKeyDown={handleKeyDown}
      />
      {onSend && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          className={cn(
            "absolute right-2 bottom-2 size-8",
            canSend && "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          <ArrowUp size={16} strokeWidth={1.5} />
        </Button>
      )}
    </div>
  )
}

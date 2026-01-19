"use client"

import * as React from "react"
import { Textarea } from "../../ui/textarea"

export interface ResponseInputProps {
  /** Current response text */
  value: string
  /** Called when response text changes */
  onChange: (text: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Ref to the underlying textarea */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * ResponseInput component - textarea for composing message responses.
 * Prevents card swipe while typing and supports auto-focus.
 */
export const ResponseInput = React.forwardRef<HTMLTextAreaElement, ResponseInputProps>(
  function ResponseInput({ value, onChange, placeholder, textareaRef }, ref) {
    // Use provided ref or forwarded ref
    const internalRef = React.useRef<HTMLTextAreaElement>(null)
    const resolvedRef = (textareaRef || ref || internalRef) as React.RefObject<HTMLTextAreaElement | null>

    return (
      <Textarea
        ref={resolvedRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "Type your response... (swipe right to send)"}
        className="min-h-[80px] max-h-[150px] resize-none bg-background w-full"
        onKeyDown={(e) => {
          // Prevent card swipe while typing
          e.stopPropagation()
        }}
      />
    )
  }
)

export default ResponseInput

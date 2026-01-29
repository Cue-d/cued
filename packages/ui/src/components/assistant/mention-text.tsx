import { Fragment } from "react"
import { MENTION_DISPLAY_REGEX } from "./mention-types"
import { cn } from "../../lib/utils"

export interface MentionTextProps {
  /** Text content that may contain mentions */
  text: string
  /** Additional class names for the container */
  className?: string
}

interface TextPart {
  type: "text" | "mention"
  content: string
  /** The full display text (name + optional context) */
  displayText?: string
}

/**
 * Parse text and split into text and mention parts
 * Uses display regex to match @Name or @Name (context) format
 */
function parseTextWithMentions(text: string): TextPart[] {
  const parts: TextPart[] = []
  let lastIndex = 0

  // Reset regex state
  MENTION_DISPLAY_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = MENTION_DISPLAY_REGEX.exec(text)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: text.substring(lastIndex, match.index),
      })
    }

    // Add the mention - displayText is the captured group (name + optional context)
    parts.push({
      type: "mention",
      content: match[0],
      displayText: match[1].trim(),
    })

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      content: text.substring(lastIndex),
    })
  }

  return parts
}

/**
 * Renders text with styled @mentions
 * Mentions are displayed as bold styled spans
 */
export function MentionText({ text, className }: MentionTextProps) {
  const parts = parseTextWithMentions(text)

  // If no mentions, just return the text
  if (parts.length === 1 && parts[0].type === "text") {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <Fragment key={index}>{part.content}</Fragment>
        }

        // Render mention as a styled span
        // Uses currentColor with color-mix to work on both user (orange) and assistant (gray) bubbles
        return (
          <span
            key={index}
            className="inline-flex items-center rounded-md border px-1.5 py-0.5 font-semibold"
            style={{
              backgroundColor: "color-mix(in srgb, currentColor 15%, transparent)",
              borderColor: "color-mix(in srgb, currentColor 20%, transparent)",
            }}
          >
            @{part.displayText}
          </span>
        )
      })}
    </span>
  )
}

/**
 * Check if text contains any mentions (display format: @Name)
 */
export function hasMentions(text: string): boolean {
  MENTION_DISPLAY_REGEX.lastIndex = 0
  return MENTION_DISPLAY_REGEX.test(text)
}

"use client"

import * as React from "react"
import { PartyPopper } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { renderActionCard } from "../../actions/cards/registry"
import type { ActionContext } from "../../actions/types"
import { cn } from "../../lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip"
import type { EnrichedAction } from "@cued/shared"

export type SwipeDirection = "left" | "right" | "up"

export interface ActionItem {
  id: string
  type: string
  /** Enriched action data (required when using internal registry) */
  action?: EnrichedAction
  [key: string]: unknown
}

export interface CardStackProps<T extends ActionItem> {
  /** Array of action items to display */
  actions: T[]
  /** Total count of actions (for display) */
  totalCount: number
  /** Called when an action is swiped */
  onSwipe: (
    actionId: string,
    direction: SwipeDirection,
    responseText?: string,
    snoozedUntil?: number
  ) => Promise<void>
  /**
   * Render function for each card's content.
   * Optional when actions include EnrichedAction data - will use internal registry.
   */
  renderCard?: (
    action: T,
    options: {
      isTop: boolean
      responseText: string
      onResponseChange: (text: string) => void
      autoFocus: boolean
    }
  ) => React.ReactNode
  /** Context for the top action (only needed when using internal registry) */
  topActionContext?: ActionContext | null
  /** Optional custom empty state */
  emptyState?: React.ReactNode
  /** Optional class name for container */
  className?: string
}

const VISIBLE_CARDS = 3

/**
 * CardStack component for the action queue.
 * Displays a stack of cards with animations and keyboard navigation.
 * Can use either a custom renderCard function or the internal card registry.
 */
export function CardStack<T extends ActionItem>({
  actions,
  totalCount,
  onSwipe,
  renderCard,
  topActionContext,
  emptyState,
  className,
}: CardStackProps<T>) {
  // State for response texts per action
  const [responseTexts, setResponseTexts] = React.useState<Record<string, string>>({})
  const [isProcessing, setIsProcessing] = React.useState(false)
  const [triggerSwipe, setTriggerSwipe] = React.useState<{
    actionId: string
    direction: SwipeDirection
  } | null>(null)

  // Refs
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Get top action ID for dependency tracking
  const topActionId = actions.length > 0 ? actions[0]?.id : null

  // Auto-focus container when top action changes
  React.useEffect(() => {
    const timer = setTimeout(() => {
      containerRef.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [topActionId])

  // Visible cards (top 3)
  const visibleActions = React.useMemo(
    () => actions.slice(0, VISIBLE_CARDS),
    [actions]
  )

  const handleResponseChange = React.useCallback((actionId: string, text: string) => {
    setResponseTexts((prev) => ({ ...prev, [actionId]: text }))
  }, [])

  const handleSwipe = React.useCallback(
    async (action: T, direction: SwipeDirection) => {
      if (isProcessing) return
      setIsProcessing(true)

      try {
        const responseText = responseTexts[action.id]
        // Default 1 hour snooze
        const snoozedUntil = direction === "up" ? Date.now() + 60 * 60 * 1000 : undefined
        await onSwipe(action.id, direction, responseText, snoozedUntil)
      } finally {
        setIsProcessing(false)
        // Clean up state for this action
        setResponseTexts((prev) => {
          const next = { ...prev }
          delete next[action.id]
          return next
        })
      }
    },
    [isProcessing, responseTexts, onSwipe]
  )

  // Handle button-triggered swipes
  const handleButtonSwipe = React.useCallback(
    (direction: SwipeDirection) => {
      if (actions.length === 0 || isProcessing) return
      const topAction = actions[0]
      setTriggerSwipe({ actionId: topAction.id, direction })
    },
    [actions, isProcessing]
  )

  // Reset triggerSwipe after animation
  React.useEffect(() => {
    if (!triggerSwipe) return
    const timer = setTimeout(() => {
      // Call the actual swipe handler
      const action = actions.find((a) => a.id === triggerSwipe.actionId)
      if (action) {
        handleSwipe(action, triggerSwipe.direction)
      }
      setTriggerSwipe(null)
    }, 200)
    return () => clearTimeout(timer)
  }, [triggerSwipe, actions, handleSwipe])

  // Keyboard navigation
  const handleContainerKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      // Ignore when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handleButtonSwipe("left")
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handleButtonSwipe("right")
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        handleButtonSwipe("up")
      }
    },
    [handleButtonSwipe]
  )

  // Escape key returns focus to container
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          e.preventDefault()
          containerRef.current?.focus()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  // Empty state
  if (actions.length === 0) {
    return (
      <motion.div
        key="empty-state"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -10 }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30,
          opacity: { duration: 0.2 },
        }}
        className="flex flex-col items-center justify-center h-full"
      >
        {emptyState || (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <PartyPopper className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">All caught up!</h3>
              <p className="text-muted-foreground text-sm mt-1">
                New actions will appear here.
              </p>
            </div>
          </div>
        )}
      </motion.div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
      className={cn("relative w-full h-full flex flex-col outline-none", className)}
    >
      {/* Header with count */}
      <div className="shrink-0 flex items-center justify-center py-3">
        <span className="text-lg font-semibold text-foreground">{totalCount} Left</span>
      </div>

      {/* Card Stack Area */}
      <div className="flex-1 relative max-w-lg mx-auto w-full">
        <AnimatePresence mode="popLayout" initial={false}>
          {visibleActions.map((action, index) => {
            const isTop = index === 0
            const stackScale = 1 - index * 0.04
            const stackY = index * 8

            const isBeingSwiped =
              triggerSwipe?.actionId === action.id ? triggerSwipe.direction : null

            return (
              <motion.div
                key={action.id}
                className="absolute inset-4"
                style={{ zIndex: VISIBLE_CARDS - index }}
                initial={{
                  scale: stackScale,
                  y: stackY,
                  opacity: index === 0 ? 0 : 1,
                }}
                animate={{
                  scale: stackScale,
                  y: stackY,
                  opacity: 1,
                  x: isBeingSwiped === "left" ? -50 : isBeingSwiped === "right" ? 50 : 0,
                  rotate: isBeingSwiped === "left" ? -5 : isBeingSwiped === "right" ? 5 : 0,
                }}
                exit={{
                  scale: stackScale * 0.95,
                  y: stackY,
                  opacity: 0,
                }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 30,
                }}
                layout
              >
                <div
                  className={cn(
                    "w-full h-full rounded-2xl bg-card border shadow-lg overflow-hidden",
                    !isTop && "pointer-events-none opacity-80"
                  )}
                >
                  {renderCard
                    ? renderCard(action, {
                        isTop,
                        responseText: responseTexts[action.id] || "",
                        onResponseChange: (text) => handleResponseChange(action.id, text),
                        autoFocus: false,
                      })
                    : action.action
                      ? renderActionCard({
                          action: action.action,
                          isTop,
                          context: isTop ? topActionContext : null,
                          responseText: responseTexts[action.id] || "",
                          onResponseChange: (text) => handleResponseChange(action.id, text),
                          autoFocus: false,
                          className: "h-full",
                        })
                      : null}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Bottom Action Buttons */}
      <div className="flex items-center justify-center shrink-0 px-4 pb-6 pt-2">
        <div className="flex items-center gap-4 max-w-md w-full">
          <Tooltip>
            <TooltipTrigger
              onClick={() => handleButtonSwipe("left")}
              disabled={isProcessing}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
                "ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:pointer-events-none disabled:opacity-50",
                "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                "h-11 px-8"
              )}
            >
              Discard
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{" "}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">
                  ←
                </kbd>
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              onClick={() => handleButtonSwipe("up")}
              disabled={isProcessing}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
                "ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:pointer-events-none disabled:opacity-50",
                "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
                "h-11 px-8"
              )}
            >
              Snooze
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{" "}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">
                  ↑
                </kbd>
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              onClick={() => handleButtonSwipe("right")}
              disabled={isProcessing}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
                "ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:pointer-events-none disabled:opacity-50",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "h-11 px-8"
              )}
            >
              Send
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Press{" "}
                <kbd className="ml-1 px-1.5 py-0.5 bg-muted/20 rounded text-xs font-mono">
                  →
                </kbd>
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export default CardStack

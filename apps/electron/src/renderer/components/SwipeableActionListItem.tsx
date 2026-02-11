import * as React from "react"
import { Trash2, Check } from "lucide-react"
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
} from "motion/react"
import {
  type EnrichedAction,
  formatRelativeTime,
  getInitials,
  PLATFORM_CONFIG,
  type ActionPlatform,
} from "@cued/shared"
import { Avatar, AvatarBadge, AvatarFallback, Button, cn, PlatformIcon } from "@cued/ui"

const SWIPE_THRESHOLD = 50
const BUTTON_WIDTH = 72
const ELASTIC_LIMIT = 12
const DEAD_ZONE = 6
const GESTURE_END_DELAY = 150
// Stiff spring for smoothing wheel-event jitter during active tracking
const TRACK_SPRING = { type: "spring" as const, stiffness: 3000, damping: 120 }
// Softer spring for the final snap — gives it weight
const SNAP_SPRING = { type: "spring" as const, stiffness: 500, damping: 45 }

interface SwipeableActionListItemProps {
  action: EnrichedAction
  selected: boolean
  multiSelected?: boolean
  showCheckbox?: boolean
  onClick: (e: React.MouseEvent) => void
  onDiscard: () => void
  typeConfig: { icon: React.ReactNode; label: string }
  onContactClick?: (contactId: string) => void
}

export function SwipeableActionListItem({
  action,
  selected,
  multiSelected = false,
  showCheckbox = false,
  onClick,
  onDiscard,
  typeConfig,
  onContactClick,
}: SwipeableActionListItemProps) {
  const x = useMotionValue(0)
  const buttonOpacity = useTransform(x, [-BUTTON_WIDTH, -20], [1, 0])
  const buttonScale = useTransform(x, [-BUTTON_WIDTH, -20], [1, 0.8])

  const containerRef = React.useRef<HTMLDivElement>(null)
  const cumulativeDelta = React.useRef(0)
  const gestureTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const revealed = React.useRef(false)
  const gestureActive = React.useRef(false)

  // Reset swipe state when the action changes
  React.useEffect(() => {
    revealed.current = false
    cumulativeDelta.current = 0
    x.jump(0)
  }, [action._id, x])

  // Respect reduced motion
  const prefersReducedMotion = React.useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  )

  const platform = action.platform as ActionPlatform | null
  const platformConfig = platform ? PLATFORM_CONFIG[platform] : null

  // Two-finger trackpad swipe via wheel events
  React.useEffect(() => {
    const el = containerRef.current
    if (!el || prefersReducedMotion) return

    const handleWheel = (e: WheelEvent) => {
      // Only handle predominantly horizontal gestures
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return

      // Accumulate horizontal delta
      cumulativeDelta.current -= e.deltaX

      // Dead zone — ignore tiny incidental horizontal movement
      if (!gestureActive.current) {
        if (Math.abs(cumulativeDelta.current) < DEAD_ZONE) return
        gestureActive.current = true
      }

      e.preventDefault()

      const base = revealed.current ? -BUTTON_WIDTH : 0
      const raw = base + cumulativeDelta.current
      // Clamp with slight elastic overshoot for natural feel
      const clamped = Math.max(
        -BUTTON_WIDTH - ELASTIC_LIMIT,
        Math.min(ELASTIC_LIMIT, raw)
      )
      // Animate to target with stiff tracking spring — smooths wheel-event jitter
      animate(x, clamped, TRACK_SPRING)

      // Debounce gesture end detection
      clearTimeout(gestureTimer.current)
      gestureTimer.current = setTimeout(() => {
        gestureActive.current = false
        const current = x.get()

        if (revealed.current) {
          // Currently open — close if swiped right enough
          if (current > -BUTTON_WIDTH + SWIPE_THRESHOLD) {
            animate(x, 0, SNAP_SPRING)
            revealed.current = false
          } else {
            animate(x, -BUTTON_WIDTH, SNAP_SPRING)
          }
        } else {
          // Currently closed — open if swiped left enough
          if (current < -SWIPE_THRESHOLD) {
            animate(x, -BUTTON_WIDTH, SNAP_SPRING)
            revealed.current = true
          } else {
            animate(x, 0, SNAP_SPRING)
          }
        }

        cumulativeDelta.current = 0
      }, GESTURE_END_DELAY)
    }

    el.addEventListener("wheel", handleWheel, { passive: false })
    return () => {
      el.removeEventListener("wheel", handleWheel)
      clearTimeout(gestureTimer.current)
    }
  }, [x, prefersReducedMotion])

  const handleClick = (e: React.MouseEvent) => {
    // If the delete button is revealed, close it instead of selecting
    if (revealed.current) {
      animate(x, 0, SNAP_SPRING)
      revealed.current = false
      cumulativeDelta.current = 0
      return
    }
    onClick(e)
  }

  const handleDiscard = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDiscard()
  }

  return (
    <motion.div
      ref={containerRef}
      data-action-id={action._id}
      className="relative overflow-hidden rounded-lg mb-1"
      layout
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      {/* Revealed discard button */}
      <motion.div
        className="absolute inset-y-0 right-0 flex items-center justify-center"
        style={{
          width: BUTTON_WIDTH,
          opacity: buttonOpacity,
          scale: buttonScale,
        }}
      >
        <Button
          variant="destructive"
          size="icon"
          onClick={handleDiscard}
          aria-label="Discard action"
          className="cursor-pointer rounded-full"
        >
          <Trash2  />
        </Button>
      </motion.div>

      {/* Swipeable content */}
      <motion.button
        type="button"
        onClick={handleClick}
        style={{ x }}
        className={`relative w-full text-left px-3 py-2.5 cursor-pointer rounded-lg bg-background ${
          selected || multiSelected ? "bg-muted" : "hover:bg-muted"
        }`}
      >
        <div className="flex items-start gap-3">
          {showCheckbox ? (
            <div
              className={`size-6 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                multiSelected
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted border border-border"
              }`}
            >
              {multiSelected && <Check className="size-3" />}
            </div>
          ) : (
            <Avatar>
              <AvatarFallback className={platformConfig?.bgClass}>
                {getInitials(action.contactName ?? "")}
              </AvatarFallback>
              {platformConfig && platform && (
                <AvatarBadge className={cn(platformConfig.bgClass, "size-4! [&>svg]:size-2.5! ring-0!")}>
                  <PlatformIcon platform={platform}/>
                </AvatarBadge>
              )}
            </Avatar>
          )}
          <div className="flex-1 min-w-0">
            {action.contactId && onContactClick ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onContactClick(action.contactId!)
                }}
                className="font-medium text-sm truncate hover:underline cursor-pointer text-left"
              >
                {action.contactName}
              </button>
            ) : (
              <span className="font-medium text-sm truncate">
                {action.contactName}
              </span>
            )}
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span>{typeConfig.label}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>{formatRelativeTime(action.createdAt)}</span>
            </div>
            {action.reason && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                {action.reason}
              </p>
            )}
          </div>
        </div>
      </motion.button>
    </motion.div>
  )
}

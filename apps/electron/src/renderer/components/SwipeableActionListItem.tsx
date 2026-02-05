import * as React from "react"
import { Trash2, Check } from "lucide-react"
import {
  motion,
  useSpring,
  useTransform,
  type PanInfo,
} from "motion/react"
import {
  type EnrichedAction,
  formatRelativeTime,
  getInitials,
  PLATFORM_CONFIG,
  type ActionPlatform,
} from "@cued/shared"
import { Badge, Avatar, AvatarFallback, Button } from "@cued/ui"

const SWIPE_THRESHOLD = -60
const BUTTON_WIDTH = 72
const SPRING_CONFIG = { stiffness: 400, damping: 30 }

interface SwipeableActionListItemProps {
  action: EnrichedAction
  selected: boolean
  multiSelected?: boolean
  showCheckbox?: boolean
  onClick: (e: React.MouseEvent) => void
  onDiscard: () => void
  typeConfig: { icon: React.ReactNode; label: string }
}

export function SwipeableActionListItem({
  action,
  selected,
  multiSelected = false,
  showCheckbox = false,
  onClick,
  onDiscard,
  typeConfig,
}: SwipeableActionListItemProps) {
  const x = useSpring(0, SPRING_CONFIG)
  const buttonOpacity = useTransform(x, [-BUTTON_WIDTH, -30], [1, 0])
  const buttonScale = useTransform(x, [-BUTTON_WIDTH, -30], [1, 0.8])

  // Respect reduced motion
  const prefersReducedMotion = React.useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  )

  const platform = action.platform as ActionPlatform | null
  const platformConfig = platform ? PLATFORM_CONFIG[platform] : null

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    // If swiped past threshold and released, snap to reveal button
    if (info.offset.x < SWIPE_THRESHOLD) {
      x.set(-BUTTON_WIDTH)
    } else {
      x.set(0)
    }
  }

  const handleDiscard = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDiscard()
  }

  return (
    <motion.div
      className="relative overflow-hidden rounded-lg mb-1"
      layout
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
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
          variant="ghost"
          size="icon"
          onClick={handleDiscard}
          aria-label="Discard action"
          className="size-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          <Trash2 className="size-5" />
        </Button>
      </motion.div>

      {/* Swipeable content */}
      <motion.button
        type="button"
        onClick={onClick}
        drag={prefersReducedMotion ? false : "x"}
        dragConstraints={{ left: -BUTTON_WIDTH, right: 0 }}
        dragElastic={0.1}
        onDragEnd={handleDragEnd}
        style={{ x }}
        className={`relative w-full text-left px-3 py-2.5 rounded-lg bg-background ${
          selected || multiSelected ? "bg-muted" : "hover:bg-muted"
        }`}
      >
        <div className="flex items-start gap-3">
          {showCheckbox ? (
            <div
              className={`mt-0.5 size-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                multiSelected
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted border border-border"
              }`}
            >
              {multiSelected && <Check className="size-4" />}
            </div>
          ) : (
            <Avatar size="sm" className="mt-0.5">
              <AvatarFallback>
                {action.contactName ? getInitials(action.contactName) : "?"}
              </AvatarFallback>
            </Avatar>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">
                {action.contactName ?? "Unknown"}
              </span>
              {platformConfig && (
                <Badge
                  variant="secondary"
                  className={`text-[10px] px-1.5 py-0 shrink-0 ${platformConfig.bgClass} ${platformConfig.textClass}`}
                >
                  {platformConfig.letter}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
              {typeConfig.icon}
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

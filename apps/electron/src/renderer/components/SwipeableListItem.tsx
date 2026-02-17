import * as React from "react";
import { motion, useMotionValue, useTransform, useSpring, animate } from "motion/react";
import { cn } from "@cued/ui";

const SWIPE_THRESHOLD = 50;
const BUTTON_WIDTH = 72;
const ELASTIC_LIMIT = 12;
const DEAD_ZONE = 6;
const GESTURE_END_DELAY = 32;
const SNAP_SPRING = { type: "spring" as const, stiffness: 400, damping: 28 };
const BUTTON_SPRING = { stiffness: 260, damping: 18, mass: 0.8 };
const BUTTON_MIN_SCALE = 0.8;
const EXIT_SCALE = 0.95;
const EXIT_DURATION = 0.12;
type RevealedSide = "none" | "left" | "right";

interface SwipeableListItemAction {
  control: React.ReactNode;
  label: string;
  labelClassName?: string;
}

interface SwipeableListItemProps {
  itemId: string;
  selected: boolean;
  multiSelected?: boolean;
  showCheckbox?: boolean;
  onClick: (e: React.MouseEvent) => void;
  openSwipeId?: string | null;
  onSwipeActiveChange?: (itemId: string | null) => void;
  leftAction: SwipeableListItemAction;
  rightAction: SwipeableListItemAction;
  children: React.ReactNode;
}

export function SwipeableListItem({
  itemId,
  selected,
  multiSelected = false,
  showCheckbox = false,
  onClick,
  openSwipeId = null,
  onSwipeActiveChange,
  leftAction,
  rightAction,
  children,
}: SwipeableListItemProps) {
  const x = useMotionValue(0);
  const rightButtonOpacity = useTransform(x, [-BUTTON_WIDTH, -20], [1, 0]);
  const rightButtonScaleRaw = useTransform(x, [-BUTTON_WIDTH, -20], [1, BUTTON_MIN_SCALE]);
  const rightButtonScale = useSpring(rightButtonScaleRaw, BUTTON_SPRING);
  const leftButtonOpacity = useTransform(x, [20, BUTTON_WIDTH], [0, 1]);
  const leftButtonScaleRaw = useTransform(x, [20, BUTTON_WIDTH], [BUTTON_MIN_SCALE, 1]);
  const leftButtonScale = useSpring(leftButtonScaleRaw, BUTTON_SPRING);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const cumulativeDelta = React.useRef(0);
  const gestureTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealedSide = React.useRef<RevealedSide>("none");
  const gestureActive = React.useRef(false);
  // Snapshot of x when gesture starts — enables interrupting mid-snap.
  const gestureStartX = React.useRef(0);

  const closeSwipe = React.useCallback((notifyParent: boolean) => {
    animate(x, 0, SNAP_SPRING);
    revealedSide.current = "none";
    cumulativeDelta.current = 0;
    if (notifyParent) {
      onSwipeActiveChange?.(null);
    }
  }, [x, onSwipeActiveChange]);

  // Reset swipe state when the row changes.
  React.useEffect(() => {
    revealedSide.current = "none";
    closeSwipe(false);
  }, [itemId, closeSwipe]);

  // If another row starts swiping/opening, close this one.
  React.useEffect(() => {
    if (openSwipeId !== itemId && revealedSide.current !== "none") {
      closeSwipe(false);
    }
  }, [itemId, closeSwipe, openSwipeId]);

  // Respect reduced motion.
  const prefersReducedMotion = React.useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Two-finger trackpad swipe via wheel events.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || prefersReducedMotion) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle predominantly horizontal gestures.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;

      cumulativeDelta.current -= e.deltaX;

      // Dead zone — ignore tiny incidental horizontal movement.
      if (!gestureActive.current) {
        if (Math.abs(cumulativeDelta.current) < DEAD_ZONE) return;
        gestureActive.current = true;
        // Snapshot current x so we can interrupt mid-snap animation.
        gestureStartX.current = x.get();
        onSwipeActiveChange?.(itemId);
      }

      e.preventDefault();

      const raw = gestureStartX.current + cumulativeDelta.current;
      // Clamp with slight elastic overshoot for natural feel.
      const clamped = Math.max(
        -BUTTON_WIDTH - ELASTIC_LIMIT,
        Math.min(BUTTON_WIDTH + ELASTIC_LIMIT, raw),
      );
      // Set directly for zero-latency tracking; spring only on snap.
      x.set(clamped);

      // Debounce gesture end detection.
      clearTimeout(gestureTimer.current);
      gestureTimer.current = setTimeout(() => {
        gestureActive.current = false;
        const current = x.get();

        let targetSide: RevealedSide = "none";
        if (revealedSide.current === "left") {
          targetSide = current > -BUTTON_WIDTH + SWIPE_THRESHOLD ? "none" : "left";
        } else if (revealedSide.current === "right") {
          targetSide = current < BUTTON_WIDTH - SWIPE_THRESHOLD ? "none" : "right";
        } else if (current < -SWIPE_THRESHOLD) {
          targetSide = "left";
        } else if (current > SWIPE_THRESHOLD) {
          targetSide = "right";
        }

        const targetX =
          targetSide === "left" ? -BUTTON_WIDTH : targetSide === "right" ? BUTTON_WIDTH : 0;
        animate(x, targetX, SNAP_SPRING);
        revealedSide.current = targetSide;
        onSwipeActiveChange?.(targetSide === "none" ? null : itemId);
        cumulativeDelta.current = 0;
      }, GESTURE_END_DELAY);
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
      clearTimeout(gestureTimer.current);
    };
  }, [itemId, onSwipeActiveChange, prefersReducedMotion, x]);

  const handleClick = (e: React.MouseEvent) => {
    // If a swipe action is revealed, close it instead of selecting.
    if (revealedSide.current !== "none") {
      closeSwipe(true);
      return;
    }
    onClick(e);
  };

  return (
    <motion.div
      ref={containerRef}
      data-swipe-item-id={itemId}
      className="relative mb-1 overflow-hidden rounded-lg"
      layout
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: EXIT_SCALE }}
      transition={{ duration: EXIT_DURATION, ease: "easeOut" }}
    >
      <motion.div
        className="absolute inset-y-0 left-0 flex flex-col items-center justify-center gap-1"
        style={{
          width: BUTTON_WIDTH,
          opacity: leftButtonOpacity,
          scale: leftButtonScale,
        }}
      >
        {leftAction.control}
        <span
          className={cn(
            "text-[10px] font-medium leading-none text-muted-foreground",
            leftAction.labelClassName,
          )}
        >
          {leftAction.label}
        </span>
      </motion.div>

      <motion.div
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-1"
        style={{
          width: BUTTON_WIDTH,
          opacity: rightButtonOpacity,
          scale: rightButtonScale,
        }}
      >
        {rightAction.control}
        <span
          className={cn(
            "text-[10px] font-medium leading-none text-muted-foreground",
            rightAction.labelClassName,
          )}
        >
          {rightAction.label}
        </span>
      </motion.div>

      <motion.button
        type="button"
        onClick={handleClick}
        aria-pressed={showCheckbox ? multiSelected : selected}
        style={{ x }}
        className={cn(
          "relative w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:duration-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          showCheckbox
            ? multiSelected
              ? "border-primary/40 bg-muted hover:bg-muted"
              : "border-border/70 bg-background hover:bg-muted/70"
            : selected
              ? "border-border bg-muted"
              : "border-transparent bg-background hover:bg-muted",
        )}
      >
        {children}
      </motion.button>
    </motion.div>
  );
}

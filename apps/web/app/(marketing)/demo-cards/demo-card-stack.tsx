"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Clock,
  GitMerge,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  AnimatePresence,
  type MotionValue,
} from "motion/react";
import { toast } from "sonner";
import { Shimmer } from "@cued/ui";
import { DemoContactCard } from "./cards/demo-contact-card";
import { DemoMessageCard } from "./cards/demo-message-card";
import { DemoResolveCard } from "./cards/demo-resolve-card";
import {
  DEMO_CARDS,
  getSwipeActions,
  type DemoCard,
  type SwipeAction,
} from "./demo-card-data";

// ── Springs ──

const reposition = { type: "spring" as const, stiffness: 300, damping: 28 };
const snapBack = { type: "spring" as const, stiffness: 400, damping: 30 };
const swipeOff = { type: "spring" as const, stiffness: 400, damping: 35 };

// ── Dimensions & thresholds ──

const CARD_W = 440;
const CARD_H = 440;
const AUTO_CYCLE_MS = 4000;
const SWIPE_THRESHOLD = 175;
const SWIPE_UP_THRESHOLD = 120;
const SWIPE_VELOCITY = 400;
const INITIAL_COUNT = 347;
const MAX_VISIBLE = 3;

// ── Radial progress ring ──

const RING_SIZE = 56;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ActionIcon({
  label,
  ...props
}: { label: string } & React.ComponentProps<LucideIcon>) {
  switch (label) {
    case "Send":
      return <ArrowUp {...props} />;
    case "Merge":
      return <GitMerge {...props} />;
    case "Save":
      return <Check {...props} />;
    case "Snooze":
      return <Clock {...props} />;
    default:
      return <X {...props} />;
  }
}

function RadialProgress({
  progress,
  action,
}: {
  progress: number;
  action: SwipeAction;
}) {
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <div
          className="absolute inset-0 rounded-full"
          style={{
            backgroundColor: action.color,
            opacity: 0.12 + progress * 0.12,
            transform: `scale(${0.6 + progress * 0.4})`,
          }}
        />
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          className="absolute inset-0 -rotate-90"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={action.color}
            strokeWidth={RING_STROKE}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        </svg>
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            opacity: Math.min(1, Math.max(0, (progress - 0.2) / 0.3)),
            transform: `scale(${0.5 + Math.min(progress, 1) * 0.5})`,
          }}
        >
          <ActionIcon
            label={action.label}
            className="size-5"
            style={{ color: action.color }}
            strokeWidth={2.5}
          />
        </div>
      </div>
      <span
        className="text-[11px] font-semibold"
        style={{
          color: action.color,
          opacity: Math.min(1, Math.max(0, (progress - 0.25) / 0.25)),
        }}
      >
        {action.label}
      </span>
    </div>
  );
}

// ── Determine dominant swipe direction ──

type SwipeDirection = "right" | "left" | "up" | null;

function getDominantDirection(
  x: number,
  y: number,
  hasUpAction: boolean,
): SwipeDirection {
  const absX = Math.abs(x);
  // Only consider upward (negative y)
  const upY = y < 0 ? -y : 0;

  if (absX < 8 && upY < 8) return null;

  // Up wins if it's dominant and card supports it
  if (hasUpAction && upY > absX * 0.8 && upY > 8) return "up";
  if (absX > 8) return x > 0 ? "right" : "left";
  return null;
}

// ── Swipe overlay (tint + radial progress) ──

function SwipeOverlay({
  dragX,
  dragY,
  card,
}: {
  dragX: MotionValue<number>;
  dragY: MotionValue<number>;
  card: DemoCard;
}) {
  const actions = getSwipeActions(card);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);

  useEffect(() => {
    const unsubX = dragX.on("change", setX);
    const unsubY = dragY.on("change", setY);
    return () => {
      unsubX();
      unsubY();
    };
  }, [dragX, dragY]);

  const direction = getDominantDirection(x, y, !!actions.up);
  if (!direction) return null;

  let action: SwipeAction;
  let progress: number;

  if (direction === "up") {
    action = actions.up!;
    progress = Math.min(-y / SWIPE_UP_THRESHOLD, 1);
  } else {
    action = direction === "right" ? actions.right : actions.left;
    progress = Math.min(Math.abs(x) / SWIPE_THRESHOLD, 1);
  }

  const tintOpacity =
    progress < 0.15 ? 0 : Math.min((progress - 0.15) * 0.24, 0.18);

  // Position: right → top-left, left → top-right, up → bottom-center
  const posStyle: React.CSSProperties =
    direction === "up"
      ? { bottom: 16, left: "50%", transform: "translateX(-50%)" }
      : { top: 16, ...(direction === "right" ? { left: 16 } : { right: 16 }) };

  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-10 rounded-2xl"
        style={{ backgroundColor: action.color, opacity: tintOpacity }}
      />
      <div
        className="pointer-events-none absolute z-20"
        style={{
          ...posStyle,
          opacity: Math.min(1, Math.max(0, (progress - 0.08) / 0.2)),
        }}
      >
        <RadialProgress progress={progress} action={action} />
      </div>
    </>
  );
}

// ── Stack positions ──

function getStackStyle(i: number) {
  return {
    y: i * 28,
    scale: 1 - i * 0.08,
    opacity: i < MAX_VISIBLE ? 1 - i * 0.2 : 0,
  };
}

// ── Card renderer ──

function renderCard(card: DemoCard) {
  switch (card.type) {
    case "message":
      return (
        <DemoMessageCard
          personName={card.personName}
          platform={card.platform}
          messages={card.messages}
          draftText={card.draftText}
          reason={card.reason}
        />
      );
    case "contact":
      return (
        <DemoContactCard
          personName={card.personName}
          platform={card.platform}
          company={card.company}
          tags={card.tags}
          notes={card.notes}
        />
      );
    case "resolve":
      return (
        <DemoResolveCard
          contact1={card.contact1}
          contact2={card.contact2}
          confidence={card.confidence}
          source={card.source}
          reasoning={card.reasoning}
        />
      );
  }
}

// ── Send toast (shimmer → sent with check) ──

const SEND_DELAY = 5000;

function SendToastContent({
  personName,
  toastId,
}: {
  personName: string;
  toastId: string | number;
}) {
  const [sent, setSent] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => setSent(true), SEND_DELAY);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleUndo = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    toast.dismiss(toastId);
  };

  return (
    <div className="relative flex h-5 w-full items-center">
      {/* Text: shimmer → sent */}
      <AnimatePresence mode="wait">
        {sent ? (
          <motion.span
            key="sent"
            className="text-sm"
            initial={{ opacity: 0, filter: "blur(4px)", y: 4 }}
            animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
            transition={{ duration: 0.3 }}
          >
            Sent to {personName}
          </motion.span>
        ) : (
          <motion.div
            key="sending"
            exit={{ opacity: 0, filter: "blur(4px)", y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <Shimmer duration={1} as="span" className="text-sm">
              {`Sending to ${personName}...`}
            </Shimmer>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Button: undo → checkmark (absolutely positioned right) */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2">
        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div
              key="check"
              className="flex size-7 items-center justify-center rounded-full bg-emerald-500"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                type: "spring",
                stiffness: 500,
                damping: 25,
                delay: 0.1,
              }}
            >
              <Check className="size-4 text-white" strokeWidth={3} />
            </motion.div>
          ) : (
            <motion.button
              key="undo"
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={handleUndo}
            >
              Undo
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Toast helper ──

type ToastType = "send" | "snooze" | "dismiss" | "save" | "merge" | "skip";

const undoAction = {
  label: "Undo",
  onClick: () => {},
};

const undoButtonStyle: React.CSSProperties = {
  borderRadius: "0.5rem",
  padding: "0.375rem 0.75rem",
  fontSize: "0.75rem",
  fontWeight: 500,
  cursor: "pointer",
};

const SNOOZE_MESSAGES = [
  "Reminding you tomorrow at 9am",
  "Reminding you in 3 hours",
  "Reminding you Monday morning",
  "Reminding you tonight at 7pm",
  "Reminding you this weekend",
  "Reminding you tomorrow afternoon",
];
let snoozeIndex = 0;

function showDemoToast(type: ToastType, personName: string) {
  switch (type) {
    case "send": {
      const id = `send-${Date.now()}`;
      toast(<SendToastContent personName={personName} toastId={id} />, {
        id,
        duration: SEND_DELAY + 3000,
        className: "[&>div]:w-full w-full",
      });
      break;
    }
    case "snooze": {
      const msg = SNOOZE_MESSAGES[snoozeIndex % SNOOZE_MESSAGES.length];
      snoozeIndex++;
      toast(msg, { action: undoAction, actionButtonStyle: undoButtonStyle });
      break;
    }
    case "save":
      toast.success(`Saved ${personName}`, {
        action: undoAction,
        actionButtonStyle: undoButtonStyle,
      });
      break;
    case "merge":
      toast.success("Contacts merged", {
        action: undoAction,
        actionButtonStyle: undoButtonStyle,
      });
      break;
  }
}

// ── Countdown badge ──

function AnimatedDigit({ digit }: { digit: string }) {
  return (
    <span className="relative inline-flex w-[0.58em] justify-center overflow-hidden">
      <AnimatePresence mode="popLayout">
        <motion.span
          key={digit}
          initial={{ opacity: 0, y: 8, filter: "blur(3px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(3px)" }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          {digit}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function CountdownBadge({ count }: { count: number }) {
  const digits = String(count).split("");

  return (
    <div className="absolute -bottom-14 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center justify-center rounded-full bg-primary px-2.5 py-1 text-xs font-semibold tabular-nums text-primary-foreground shadow-lg">
        <span className="inline-flex">
          {digits.map((d, i) => (
            <AnimatedDigit key={i} digit={d} />
          ))}
        </span>
        <span className="ml-1">in queue</span>
      </div>
    </div>
  );
}

// ── Exiting card (flies off independently while stack reorders beneath) ──

interface ExitingCardInfo {
  key: number;
  card: DemoCard;
  targetX: number;
  targetY: number;
  initialX: number;
  initialY: number;
  velocityX: number;
  velocityY: number;
}

function ExitingCard({
  data,
  onComplete,
}: {
  data: ExitingCardInfo;
  onComplete: () => void;
}) {
  const isVertical = data.targetY !== 0;

  return (
    <motion.div className="absolute inset-0" style={{ zIndex: 100 }}>
      <motion.div
        className="h-full w-full"
        initial={{
          x: data.initialX,
          y: data.initialY,
          rotate: data.initialX * 0.04,
          opacity: 1,
        }}
        animate={{
          x: data.targetX,
          y: data.targetY,
          rotate: data.targetX * 0.04,
          opacity: 0,
        }}
        transition={{
          x: { ...swipeOff, velocity: isVertical ? 0 : data.velocityX },
          y: { ...swipeOff, velocity: isVertical ? data.velocityY : 0 },
          rotate: swipeOff,
          opacity: { duration: 0.35, ease: "easeOut" },
        }}
        onAnimationComplete={onComplete}
      >
        <div className="relative h-full w-full overflow-hidden rounded-2xl bg-card shadow-[0_8px_30px_rgb(0,0,0,0.08),0_2px_8px_rgb(0,0,0,0.04)]">
          {renderCard(data.card)}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Each card in the stack ──

function StackCard({
  card,
  index,
  total,
  onDragStateChange,
  onSwipe,
}: {
  card: DemoCard;
  index: number;
  total: number;
  onDragStateChange: (dragging: boolean) => void;
  onSwipe: (
    direction: "right" | "left" | "up",
    offsetX: number,
    offsetY: number,
    velocityX: number,
    velocityY: number,
  ) => void;
}) {
  const isTop = index === 0;
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const rotate = useTransform(dragX, [-300, 0, 300], [-12, 0, 12]);
  const dragOpacity = useTransform(
    dragX,
    [-400, -200, 0, 200, 400],
    [0.3, 0.85, 1, 0.85, 0.3],
  );

  const hasUpAction = !!getSwipeActions(card).up;
  const style = getStackStyle(index);

  const handleDragEnd = useCallback(
    (
      _: unknown,
      info: {
        velocity: { x: number; y: number };
        offset: { x: number; y: number };
      },
    ) => {
      const x = info.offset.x;
      const y = info.offset.y;
      const vx = info.velocity.x;
      const vy = info.velocity.y;

      // Check upward swipe first (negative y = upward)
      if (hasUpAction && -y >= SWIPE_UP_THRESHOLD && -y > Math.abs(x) * 0.8) {
        // Fire immediately — parent takes over exit animation
        onSwipe("up", x, y, vx, vy);
        onDragStateChange(false);
        return;
      }

      // Horizontal swipe
      if (Math.abs(x) >= SWIPE_THRESHOLD || Math.abs(vx) >= SWIPE_VELOCITY) {
        const dir =
          Math.abs(x) >= SWIPE_THRESHOLD ? Math.sign(x) : Math.sign(vx);
        onSwipe(dir > 0 ? "right" : "left", x, y, vx, vy);
        onDragStateChange(false);
      } else {
        onDragStateChange(false);
        animate(dragX, 0, snapBack);
        animate(dragY, 0, snapBack);
      }
    },
    [dragX, dragY, hasUpAction, onSwipe, onDragStateChange],
  );

  return (
    <motion.div
      className="absolute inset-0"
      style={{ zIndex: total - index }}
      initial={{
        y: style.y,
        scale: style.scale,
        opacity: style.opacity,
      }}
      animate={{
        y: style.y,
        scale: style.scale,
        opacity: style.opacity,
      }}
      transition={reposition}
    >
      <motion.div
        className={
          isTop
            ? "h-full w-full cursor-grab active:cursor-grabbing"
            : "h-full w-full"
        }
        style={{
          x: isTop ? dragX : 0,
          y: isTop ? dragY : 0,
          rotate: isTop ? rotate : 0,
          opacity: isTop ? dragOpacity : 1,
        }}
        whileHover={isTop ? { scale: 1.008 } : undefined}
        whileTap={isTop ? { scale: 0.985 } : undefined}
        transition={{ type: "spring", stiffness: 200, damping: 25 }}
        drag={isTop}
        dragElastic={0.7}
        dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
        onDragStart={isTop ? () => onDragStateChange(true) : undefined}
        onDragEnd={isTop ? handleDragEnd : undefined}
      >
        <div className="relative h-full w-full overflow-hidden rounded-2xl bg-card shadow-[0_8px_30px_rgb(0,0,0,0.08),0_2px_8px_rgb(0,0,0,0.04)]">
          {renderCard(card)}
          {isTop && <SwipeOverlay dragX={dragX} dragY={dragY} card={card} />}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Resolve action label from swipe direction ──

function resolveActionType(
  card: DemoCard,
  direction: "right" | "left" | "up",
): ToastType | null {
  const actions = getSwipeActions(card);
  const action = direction === "up" ? actions.up : actions[direction];
  if (!action) return null;
  switch (action.label) {
    case "Send":
      return "send";
    case "Snooze":
      return "snooze";
    case "Save":
      return "save";
    case "Merge":
      return "merge";
    case "Skip":
      return "skip";
    case "Dismiss":
    case "Different":
      return "dismiss";
    default:
      return null;
  }
}

function getCardName(card: DemoCard): string {
  if (card.type === "resolve") return card.contact1.name;
  return card.personName;
}

// ── Apple-style swipe hints ──

function HintKeycap({
  children,
  active,
  color,
}: {
  children: React.ReactNode;
  active: boolean;
  color: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[5px] border px-1.5 py-0.5 font-mono text-[10px] leading-none transition-all duration-150 ${
        active
          ? "shadow-sm"
          : "border-border/70 bg-muted/70 text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border)/0.5)]"
      }`}
      style={
        active
          ? {
              borderColor: `${color}60`,
              backgroundColor: `${color}22`,
              color,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

function HintPill({
  direction,
  action,
  active,
  breathe,
}: {
  direction: "left" | "right" | "up";
  action: SwipeAction;
  active: boolean;
  breathe: boolean;
}) {
  const arrows: Record<string, string> = {
    left: "←",
    right: "→",
    up: "↑",
  };
  const isLeft = direction === "left";

  return (
    <motion.div
      className="flex items-center gap-1.5"
      animate={
        active
          ? { opacity: 1, scale: 1.08 }
          : breathe
            ? { opacity: [0.7, 0.9, 0.7], scale: 1 }
            : { opacity: 0.8, scale: 1 }
      }
      transition={
        active
          ? { duration: 0.15 }
          : breathe
            ? { duration: 3, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3 }
      }
    >
      {isLeft && (
        <HintKeycap active={active} color={action.color}>
          {arrows[direction]}
        </HintKeycap>
      )}
      <span
        className="text-[11px] font-medium text-muted-foreground transition-colors duration-150"
        style={active ? { color: action.color } : undefined}
      >
        {action.label}
      </span>
      {!isLeft && (
        <HintKeycap active={active} color={action.color}>
          {arrows[direction]}
        </HintKeycap>
      )}
    </motion.div>
  );
}

function SwipeHints({
  card,
  lastKeyDirection,
}: {
  card: DemoCard;
  lastKeyDirection: SwipeDirection;
}) {
  const actions = getSwipeActions(card);
  const [breathe, setBreathe] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setBreathe(true), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      className="flex items-center justify-center gap-5 pt-[92px]"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 1, duration: 0.5 }}
    >
      <HintPill
        direction="left"
        action={actions.left}
        active={lastKeyDirection === "left"}
        breathe={breathe}
      />
      <AnimatePresence>
        {actions.up && (
          <motion.div
            key="up-hint"
            initial={{ opacity: 0, scale: 0.8, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: "auto" }}
            exit={{ opacity: 0, scale: 0.8, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <HintPill
              direction="up"
              action={actions.up}
              active={lastKeyDirection === "up"}
              breathe={breathe}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <HintPill
        direction="right"
        action={actions.right}
        active={lastKeyDirection === "right"}
        breathe={breathe}
      />
    </motion.div>
  );
}

// ── Main export ──

let exitKey = 0;

export function DemoCardStack() {
  const [order, setOrder] = useState(() => DEMO_CARDS.map((c) => c.id));
  const [remaining, setRemaining] = useState(INITIAL_COUNT);
  const [exitingCard, setExitingCard] = useState<ExitingCardInfo | null>(null);
  const isDragging = useRef(false);
  const [lastKeyDirection, setLastKeyDirection] =
    useState<SwipeDirection>(null);
  const swipeCooldown = useRef(false);

  const cycleTop = useCallback(() => {
    setOrder((prev) => [...prev.slice(1), prev[0]]);
    setRemaining((prev) => Math.max(0, prev - 1));
  }, []);

  // Fires exit animation + reorders stack immediately
  const fireSwipe = useCallback(
    (
      card: DemoCard,
      direction: "right" | "left" | "up",
      initialX: number,
      initialY: number,
      velocityX: number,
      velocityY: number,
    ) => {
      let targetX = 0;
      let targetY = 0;
      if (direction === "up") {
        targetY = -1200;
      } else {
        targetX = direction === "right" ? 1000 : -1000;
      }

      // Launch exit animation in a separate layer
      setExitingCard({
        key: ++exitKey,
        card,
        targetX,
        targetY,
        initialX,
        initialY,
        velocityX,
        velocityY,
      });

      // Reorder the stack immediately — cards shift up right away
      cycleTop();

      // Show toast
      const actionType = resolveActionType(card, direction);
      if (actionType && actionType !== "dismiss" && actionType !== "skip") {
        showDemoToast(actionType, getCardName(card));
      }
    },
    [cycleTop],
  );

  const handleSwipe = useCallback(
    (
      direction: "right" | "left" | "up",
      offsetX: number,
      offsetY: number,
      velocityX: number,
      velocityY: number,
    ) => {
      const topId = order[0];
      const card = DEMO_CARDS.find((c) => c.id === topId);
      if (!card) return;
      fireSwipe(card, direction, offsetX, offsetY, velocityX, velocityY);
    },
    [order, fireSwipe],
  );

  const handleDragStateChange = useCallback((dragging: boolean) => {
    isDragging.current = dragging;
  }, []);

  // Auto-cycle: launch exit animation + reorder immediately
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isDragging.current) return;

      const topId = order[0];
      const card = DEMO_CARDS.find((c) => c.id === topId);
      if (!card) return;

      fireSwipe(card, "right", 0, 0, 0, 0);
    }, AUTO_CYCLE_MS);
    return () => clearTimeout(timer);
  }, [order, fireSwipe]);

  // Arrow-key swipe
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDragging.current || swipeCooldown.current) return;

      const topId = order[0];
      const card = DEMO_CARDS.find((c) => c.id === topId);
      if (!card) return;

      const actions = getSwipeActions(card);
      let direction: SwipeDirection = null;

      switch (e.key) {
        case "ArrowRight":
          direction = "right";
          break;
        case "ArrowLeft":
          direction = "left";
          break;
        case "ArrowUp":
          if (actions.up) direction = "up";
          break;
      }

      if (!direction) return;
      e.preventDefault();

      swipeCooldown.current = true;
      setTimeout(() => {
        swipeCooldown.current = false;
      }, 500);

      setLastKeyDirection(direction);
      setTimeout(() => setLastKeyDirection(null), 300);

      fireSwipe(card, direction, 0, 0, 0, 0);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [order, fireSwipe]);

  const topCard = DEMO_CARDS.find((c) => c.id === order[0])!;

  return (
    <div
      className="relative mx-auto"
      style={{ width: CARD_W + 48, padding: "6px 24px" }}
    >
      <div className="relative" style={{ width: CARD_W, height: CARD_H + 68 }}>
        <CountdownBadge count={remaining} />

        {/* Exiting card — animates off independently */}
        {exitingCard && (
          <ExitingCard
            key={exitingCard.key}
            data={exitingCard}
            onComplete={() => setExitingCard(null)}
          />
        )}

        {/* Visible stack */}
        {order
          .slice(0, MAX_VISIBLE)
          .reverse()
          .map((id) => {
            const card = DEMO_CARDS.find((c) => c.id === id)!;
            const index = order.indexOf(id);
            return (
              <StackCard
                key={id}
                card={card}
                index={index}
                total={order.length}
                onDragStateChange={handleDragStateChange}
                onSwipe={handleSwipe}
              />
            );
          })}
      </div>

      {/* Apple-style swipe hints */}
      <SwipeHints card={topCard} lastKeyDirection={lastKeyDirection} />
    </div>
  );
}

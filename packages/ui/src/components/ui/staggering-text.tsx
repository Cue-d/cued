import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useInViewLoop } from "../../hooks/use-in-view-loop";

export function StaggeringText({
  children = "Request Access",
  rotateX = 80,
  stagger = true,
  hover: controlledHover,
  className = "",
  onAnimationStart,
  onAnimationComplete,
}: {
  children?: string;
  rotateX?: number;
  stagger?: boolean;
  hover?: boolean;
  className?: string;
  onAnimationStart?: () => void;
  onAnimationComplete?: () => void;
}) {
  const [internalHover, ref] = useInViewLoop(
    1500,
    controlledHover === undefined
  );
  const targetHover = controlledHover !== undefined ? controlledHover : internalHover;

  // Track animation state to prevent interruption
  const [displayedHover, setDisplayedHover] = useState(targetHover);
  const isAnimatingRef = useRef(false);
  const pendingHoverRef = useRef<boolean | null>(null);

  // When target hover changes, either apply immediately or queue for later
  useEffect(() => {
    if (targetHover === displayedHover) {
      pendingHoverRef.current = null;
      return;
    }

    if (isAnimatingRef.current) {
      // Animation in progress - queue the new state
      pendingHoverRef.current = targetHover;
    } else {
      // No animation - apply immediately
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayedHover(targetHover);
    }
  }, [targetHover, displayedHover]);

  const hover = displayedHover;
  const chunks = children.split("");

  const target = {
    rotateX,
    y: -16,
    filter: "blur(4px)",
  };

  const transition = {
    type: "spring",
    stiffness: 250,
    damping: 30,
  } as const;

  const gridStackStyle = {
    display: "grid",
    placeItems: "center center",
  } as const;

  const gridChildStyle = {
    gridArea: "1 / 1",
  } as const;

  return (
    <div ref={ref} className="w-fit" style={gridStackStyle} aria-label={children}>
      <div className={className} style={gridChildStyle} aria-hidden>
        <AnimatePresence initial={false}>
          {chunks.map((letter, index) => {
            let delay = hover
              ? index * 0.05
              : (chunks.length - 1 - index) * 0.06;

            if (stagger === false) {
              delay = 0;
            }

            return (
              <motion.span
                className="inline-block"
                animate={{
                  rotateX: hover ? target.rotateX : 0,
                  y: hover ? target.y : 0,
                  filter: hover ? target.filter : "blur(0px)",
                  opacity: hover ? 0 : 1,
                }}
                key={index}
                style={{
                  ...(letter === " " && {
                    display: "inline",
                    width: "0.25em",
                  }),
                }}
                onAnimationStart={() => {
                  if (index === 0) {
                    isAnimatingRef.current = true;
                    onAnimationStart?.();
                  }
                }}
                onAnimationComplete={() => {
                  if (index === chunks.length - 1) {
                    isAnimatingRef.current = false;
                    onAnimationComplete?.();
                    // Apply pending hover state if any
                    if (pendingHoverRef.current !== null) {
                      setDisplayedHover(pendingHoverRef.current);
                      pendingHoverRef.current = null;
                    }
                  }
                }}
                transition={{
                  delay,
                  ...transition,
                }}
              >
                {letter}
              </motion.span>
            );
          })}
        </AnimatePresence>
      </div>
      <div aria-hidden className={className} style={gridChildStyle}>
        <AnimatePresence initial={false}>
          {chunks.map((letter, index) => {
            let delay = hover
              ? 0.1 + index * 0.05
              : (chunks.length - 1 - index) * 0.05;

            if (stagger === false) {
              delay = 0;
            }

            return (
              <motion.span
                className="inline-block"
                animate={{
                  rotateX: hover ? 360 : 270,
                  y: hover ? 0 : target.y * -1,
                  filter: hover ? "blur(0px)" : target.filter,
                  opacity: hover ? 1 : 0,
                }}
                key={index}
                style={{
                  ...(letter === " " && {
                    display: "inline",
                    width: "0.25em",
                  }),
                }}
                transition={{
                  ...transition,
                  delay,
                }}
              >
                {letter}
              </motion.span>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

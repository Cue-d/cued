"use client";

import { useRef, useState, useCallback, useId, useEffect } from "react";
import { motion, type Variants } from "motion/react";
import type { CSSProperties } from "react";

// Re-export static components for backwards compatibility
export { CuedLogoStatic, CuedLogoMono } from "./cued-logo-static";

interface CuedLogoAnimatedProps {
  /** Size in pixels */
  size?: number;
  /** CSS class name */
  className?: string;
  /** Inline styles */
  style?: CSSProperties;
  /** Show rolling animation (for loading states) */
  animate?: boolean;
  /** Animation speed in seconds per rotation */
  animationDuration?: number;
  /** Enable cursor-following dot interaction */
  interactive?: boolean;
  /** External container ref for mouse tracking (for group hover) */
  trackingRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Cued Logo - A cue ball (circle with centered dot)
 * Client component with animation and interaction support.
 */
export function CuedLogo({
  size = 32,
  animate = false,
  animationDuration = 1.2,
  interactive = false,
  trackingRef,
  className,
  style,
}: CuedLogoAnimatedProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dotOffset, setDotOffset] = useState({ x: 0, y: 0 });
  const filterId = useId();

  const handlePointerMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!interactive || !svgRef.current) return;

      const rect = svgRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Calculate distance from center (normalized to -1 to 1)
      const dx = (clientX - centerX) / (rect.width / 2);
      const dy = (clientY - centerY) / (rect.height / 2);

      // Limit movement to a small radius (max 1.5 units for subtler effect)
      const maxOffset = 1.5;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const scale = distance > 1 ? 1 / distance : 1;

      const newX = dx * scale * maxOffset;
      const newY = dy * scale * maxOffset;

      setDotOffset({ x: newX, y: newY });
    },
    [interactive],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      handlePointerMove(e.clientX, e.clientY);
    },
    [handlePointerMove],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        handlePointerMove(touch.clientX, touch.clientY);
      }
    },
    [handlePointerMove],
  );

  const handlePointerLeave = useCallback(() => {
    if (!interactive) return;
    setDotOffset({ x: 0, y: 0 });
  }, [interactive]);

  // Attach listeners to tracking element if using external ref
  useEffect(() => {
    if (!trackingRef?.current || !interactive) return;

    const el = trackingRef.current;
    el.addEventListener("mousemove", handleMouseMove);
    el.addEventListener("mouseleave", handlePointerLeave);
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handlePointerLeave);
    el.addEventListener("touchcancel", handlePointerLeave);

    return () => {
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("mouseleave", handlePointerLeave);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handlePointerLeave);
      el.removeEventListener("touchcancel", handlePointerLeave);
    };
  }, [trackingRef, interactive, handleMouseMove, handleTouchMove, handlePointerLeave]);

  const rollVariants: Variants = {
    idle: { rotate: 0 },
    rolling: {
      rotate: 360,
      transition: {
        duration: animationDuration,
        ease: "linear",
        repeat: Infinity,
      },
    },
  };

  return (
    <motion.svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ cursor: "pointer", overflow: "visible", ...style }}
      variants={rollVariants}
      initial="idle"
      animate={animate ? "rolling" : "idle"}
      onMouseMove={trackingRef ? undefined : handleMouseMove}
      onMouseLeave={trackingRef ? undefined : handlePointerLeave}
      onTouchMove={trackingRef ? undefined : (e) => {
        if (e.touches.length > 0) {
          const touch = e.touches[0];
          handlePointerMove(touch.clientX, touch.clientY);
        }
      }}
      onTouchEnd={trackingRef ? undefined : handlePointerLeave}
      onTouchCancel={trackingRef ? undefined : handlePointerLeave}
    >
      <defs>
        {/* Drop shadow (box shadow) */}
        <filter
          id={`drop-shadow-${filterId}`}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feDropShadow
            dx="0"
            dy="1"
            stdDeviation="1.5"
            floodColor="black"
            floodOpacity="0.08"
          />
        </filter>
        {/* Inner shadow filter */}
        <filter
          id={`inner-shadow-${filterId}`}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feComponentTransfer in="SourceAlpha">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feGaussianBlur stdDeviation="3" />
          <feOffset dx="0" dy="2" result="offsetblur" />
          <feFlood floodColor="black" floodOpacity="0.45" />
          <feComposite in2="offsetblur" operator="in" />
          <feComposite in2="SourceAlpha" operator="in" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode />
          </feMerge>
        </filter>
      </defs>
      {/* Outer circle with drop shadow and inner shadow */}
      <g filter={`url(#drop-shadow-${filterId})`}>
        <circle
          cx="16"
          cy="16"
          r="13"
          fill="var(--color-logo-ball)"
          filter={`url(#inner-shadow-${filterId})`}
        />
      </g>
      {/* Center dot - simple circle with smooth position tracking */}
      <motion.circle
        cx={16}
        cy={16}
        r={2.5}
        fill="var(--color-orange)"
        animate={{
          cx: 16 + dotOffset.x,
          cy: 16 + dotOffset.y,
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30,
        }}
      />
    </motion.svg>
  );
}

/**
 * Animated loading variant of the logo
 */
export function CuedLogoLoading({
  size = 24,
  ...props
}: Omit<CuedLogoAnimatedProps, "animate">) {
  return <CuedLogo size={size} animate {...props} />;
}

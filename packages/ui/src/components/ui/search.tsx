"use client";

import { forwardRef, useCallback } from "react";
import { motion } from "motion/react";
import { useAnimatedIcon, type AnimatedIconHandle, type MotionControls } from "../../hooks/use-animated-icon";
import { cn } from "../../lib/utils";
import type { HTMLAttributes } from "react";


export type SearchIconHandle = AnimatedIconHandle;

interface SearchIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const SearchIcon = forwardRef<SearchIconHandle, SearchIconProps>(
  ({ className, size = 28, ...props }, ref) => {
    const onStart = useCallback(
      (controls: MotionControls) => {
        controls.start("animate");
      },
      []
    );
    const onStop = useCallback(
      (controls: MotionControls) => {
        controls.start("normal");
      },
      []
    );

    const { controls, handleMouseEnter, handleMouseLeave } = useAnimatedIcon(ref, onStart, onStop);

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <motion.svg
          animate={controls}
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          transition={{
            duration: 1,
            bounce: 0.3,
          }}
          variants={{
            normal: { x: 0, y: 0 },
            animate: {
              x: [0, 0, -3, 0],
              y: [0, -4, 0, 0],
            },
          }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </motion.svg>
      </div>
    );
  }
);

SearchIcon.displayName = "SearchIcon";

export { SearchIcon };

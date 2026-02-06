import { forwardRef, useCallback } from "react";
import { motion } from "motion/react";
import { useAnimatedIcon, type AnimatedIconHandle, type MotionControls } from "../../hooks/use-animated-icon";
import { cn } from "../../lib/utils";
import type { Variants } from "motion/react";
import type { HTMLAttributes } from "react";

export type UserIconHandle = AnimatedIconHandle;

interface UserIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const PATH_VARIANT: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
  },
};

const CIRCLE_VARIANT: Variants = {
  normal: {
    pathLength: 1,
    pathOffset: 0,
    scale: 1,
  },
  animate: {
    pathLength: [0, 1],
    pathOffset: [1, 0],
    scale: [0.5, 1],
  },
};

const UserIcon = forwardRef<UserIconHandle, UserIconProps>(
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
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.circle
            animate={controls}
            cx="12"
            cy="8"
            r="5"
            variants={CIRCLE_VARIANT}
          />

          <motion.path
            animate={controls}
            d="M20 21a8 8 0 0 0-16 0"
            transition={{
              delay: 0.2,
              duration: 0.4,
            }}
            variants={PATH_VARIANT}
          />
        </svg>
      </div>
    );
  }
);

UserIcon.displayName = "UserIcon";

export { UserIcon };

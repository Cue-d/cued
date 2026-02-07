"use client";

import {
  useCallback,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
} from "react";
import { useAnimation } from "motion/react";

export type MotionControls = ReturnType<typeof useAnimation>;

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

/**
 * Shared hook for animated icon components.
 * Handles imperative ref (startAnimation/stopAnimation), hover triggers,
 * and the controlled-vs-uncontrolled distinction.
 */
export function useAnimatedIcon(
  ref: ForwardedRef<AnimatedIconHandle>,
  onStart: (controls: MotionControls) => void,
  onStop: (controls: MotionControls) => void,
) {
  const controls = useAnimation();
  const isControlledRef = useRef(false);

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;
    return {
      startAnimation: () => onStart(controls),
      stopAnimation: () => onStop(controls),
    };
  });

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlledRef.current) {
        onStart(controls);
      }
    },
    [controls, onStart]
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlledRef.current) {
        onStop(controls);
      }
    },
    [controls, onStop]
  );

  return { controls, handleMouseEnter, handleMouseLeave };
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

export function useInViewLoop(
  duration: number = 1500,
  play = true,
  callback?: () => void
): [boolean, React.RefObject<HTMLDivElement | null>] {
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(ref);

  useEffect(() => {
    if (!isInView || !play) return;
    const interval = setInterval(() => {
      setActive((a) => !a);
      callback?.();
    }, duration);
    return () => clearInterval(interval);
  }, [play, isInView, duration, callback]);

  return [active, ref];
}

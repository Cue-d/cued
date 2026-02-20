"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { CuedMark } from "@cued/ui";

export function MarketingHeader() {
  const [logoHovered, setLogoHovered] = useState(false);

  return (
    <header className="absolute top-0 left-0 right-0 z-50">
      <nav className="flex h-16 items-center justify-between px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-1.5 active:scale-98 transition-transform"
          onMouseEnter={() => setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
          onTouchStart={() => setLogoHovered(true)}
          onTouchEnd={() => setLogoHovered(false)}
          onTouchCancel={() => setLogoHovered(false)}
        >
          <CuedMark size={16} />
          <span className="text-lg leading-0 font-semibold tracking-[-0.075em] inline-flex">
            <span>Cue</span>
            <span className="relative inline-flex">
              <AnimatePresence>
                {logoHovered && (
                  <motion.span
                    className="inline-block leading-0 -tracking-widest"
                    initial={{
                      opacity: 0,
                      rotate: -4,
                      width: 0,
                      filter: "blur(3px)",
                    }}
                    animate={{
                      opacity: 1,
                      rotate: 8,
                      width: "auto",
                      filter: "blur(0px)",
                    }}
                    exit={{
                      opacity: 0,
                      rotate: -4,
                      width: 0,
                      filter: "blur(3px)",
                    }}
                    transition={{
                      type: "spring",
                      stiffness: 400,
                      damping: 27.5,
                    }}
                  >
                    &apos;
                  </motion.span>
                )}
              </AnimatePresence>
              <span>d</span>
            </span>
          </span>
        </Link>

      </nav>
    </header>
  );
}

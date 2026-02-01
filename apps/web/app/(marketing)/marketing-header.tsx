"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { CuedLogo } from "@cued/ui";

export function MarketingHeader() {
  const [logoHovered, setLogoHovered] = useState(false);
  const logoGroupRef = useRef<HTMLAnchorElement>(null);

  return (
    <header className="absolute top-0 left-0 right-0 z-50">
      <nav className="flex h-16 items-center justify-between px-6 lg:px-8">
        <Link
          href="/"
          ref={logoGroupRef}
          className="flex items-center gap-1.5"
          onMouseEnter={() => setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
          onTouchStart={() => setLogoHovered(true)}
          onTouchEnd={() => setLogoHovered(false)}
          onTouchCancel={() => setLogoHovered(false)}
        >
          <CuedLogo size={24} interactive trackingRef={logoGroupRef} />
          <span className="text-lg font-medium tracking-tighter inline-flex">
            <span>Cue</span>
            <span className="relative inline-flex">
              <AnimatePresence>
                {logoHovered && (
                  <motion.span
                    className="inline-block"
                    initial={{ opacity: 0, rotate: -4, width: 0, filter: "blur(3px)" }}
                    animate={{ opacity: 1, rotate: 8, width: "auto", filter: "blur(0px)" }}
                    exit={{ opacity: 0, rotate: -4, width: 0, filter: "blur(3px)" }}
                    transition={{
                      type: "spring",
                      stiffness: 325,
                      damping: 25,
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
        <div className="flex items-center gap-2">
          <Link
            href="/manifesto"
            className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Manifesto
          </Link>
        </div>
      </nav>
    </header>
  );
}

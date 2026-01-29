"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";

const words = [
  "texts",
  "follow-ups",
  "friends",
  "emails",
  "Slacks",
  "intros",
  "prospects",
  "deals",
  "leads",
  "contacts",
];

export default function Home() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  const nextWord = useCallback(() => {
    if (!isAnimating) {
      setCurrentIndex((prev) => (prev + 1) % words.length);
    }
  }, [isAnimating]);

  useEffect(() => {
    const interval = setInterval(nextWord, 3000);
    return () => clearInterval(interval);
  }, [nextWord]);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-6">
      {/* Hero */}
      <div className="flex flex-col items-center text-center">
        <LayoutGroup>
          <motion.h1
            layout
            className="flex items-baseline justify-center gap-[0.2em] text-4xl font-medium tracking-tighter sm:text-5xl md:text-5xl"
            transition={{
              layout: {
                type: "spring",
                stiffness: 300,
                damping: 30,
              },
            }}
          >
            <motion.span
              layout
              transition={{
                layout: {
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                },
              }}
            >
              Never miss
            </motion.span>
            <motion.span
              layout
              className="relative inline-flex"
              transition={{
                layout: {
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                },
              }}
            >
              <AnimatePresence mode="wait">
                <StaggerText
                  key={words[currentIndex]}
                  text={words[currentIndex]}
                  onAnimationStart={() => setIsAnimating(true)}
                  onAnimationComplete={() => setIsAnimating(false)}
                />
              </AnimatePresence>
            </motion.span>
          </motion.h1>
        </LayoutGroup>
        <p className="mt-2 max-w-xl text-pretty text-lg text-muted-foreground">
          A unified inbox so you never drop a conversation.
        </p>
        <div className="mt-8 flex items-center gap-4">
          <Link
            href="/sign-up"
            className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get Started
          </Link>
        </div>

      </div>

      {/* Product Preview - outside the animated container */}
      <div className="mt-16 w-full max-w-4xl px-6">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-muted/30 dark:border-white/10 dark:bg-white/5">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <PlayIcon className="size-12" />
              <span className="text-sm font-medium">Watch demo</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StaggerText({
  text,
  onAnimationStart,
  onAnimationComplete,
}: {
  text: string;
  onAnimationStart?: () => void;
  onAnimationComplete?: () => void;
}) {
  const characters = text.split("");
  const animationStarted = useRef(false);
  const completedCount = useRef(0);

  const handleAnimationStart = () => {
    if (!animationStarted.current) {
      animationStarted.current = true;
      onAnimationStart?.();
    }
  };

  const handleAnimationComplete = () => {
    completedCount.current += 1;
    if (completedCount.current === characters.length) {
      onAnimationComplete?.();
    }
  };

  return (
    <motion.span
      layout
      initial="hidden"
      animate="visible"
      exit="exit"
      className="inline-flex text-muted-foreground"
      aria-label={text}
      transition={{
        layout: {
          type: "spring",
          stiffness: 300,
          damping: 30,
        },
      }}
    >
      {characters.map((char, index) => (
        <motion.span
          key={index}
          className="inline-block"
          style={char === " " ? { width: "0.25em" } : undefined}
          variants={{
            hidden: {
              opacity: 0,
              y: 20,
              rotateX: 90,
              filter: "blur(4px)",
            },
            visible: {
              opacity: 1,
              y: 0,
              rotateX: 0,
              filter: "blur(0px)",
            },
            exit: {
              opacity: 0,
              y: -20,
              rotateX: -90,
              filter: "blur(4px)",
            },
          }}
          transition={{
            type: "spring",
            stiffness: 200,
            damping: 20,
            delay: index * 0.03,
          }}
          onAnimationStart={index === 0 ? handleAnimationStart : undefined}
          onAnimationComplete={handleAnimationComplete}
        >
          {char === " " ? "\u00A0" : char}
        </motion.span>
      ))}
    </motion.span>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm14.024-.983a1.125 1.125 0 010 1.966l-5.603 3.113A1.125 1.125 0 019 15.113V8.887c0-.857.921-1.4 1.671-.983l5.603 3.113z"
        clipRule="evenodd"
      />
    </svg>
  );
}

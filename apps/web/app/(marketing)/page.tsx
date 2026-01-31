"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGroup, motion } from "motion/react";

export default function Home() {
  const [isHovering, setIsHovering] = useState(false);

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
              className="relative inline-flex cursor-pointer"
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
              transition={{
                layout: {
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                },
              }}
            >
              <StaggerText text="texts" isHovering={isHovering} />
            </motion.span>
          </motion.h1>
        </LayoutGroup>
        <p className="mt-2 max-w-xl text-pretty text-lg text-muted-foreground">
          A unified inbox so you never drop a conversation.
        </p>
        <div className="mt-8 flex items-center gap-4">
          <Link
            href="/sign-up"
            className="inline-flex h-14 items-center justify-center rounded-full bg-primary px-10 text-lg font-medium text-primary-foreground transition-colors hover:bg-primary/90"
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
  isHovering,
}: {
  text: string;
  isHovering: boolean;
}) {
  const characters = text.split("");

  return (
    <motion.span
      layout
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
          animate={isHovering ? "visible" : "hidden"}
          initial={false}
          variants={{
            hidden: {
              opacity: 1,
              y: 0,
              rotateX: 0,
              filter: "blur(0px)",
            },
            visible: {
              opacity: 1,
              y: -4,
              rotateX: -10,
              filter: "blur(0px)",
            },
          }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 25,
            delay: index * 0.02,
          }}
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

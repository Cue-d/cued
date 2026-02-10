"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight } from "lucide-react";
import { CuedLogo } from "@cued/ui";
import { StaggeringText } from "./components/staggering-text";
import { DemoCardStack } from "./demo-cards/demo-card-stack";

export default function Home() {
  const [isHovered, setIsHovered] = useState(false);
  const [logoHovered, setLogoHovered] = useState(false);
  const logoGroupRef = useRef<HTMLAnchorElement>(null);
  const router = useRouter();
  return (
    <div className="relative flex min-h-screen flex-col lg:flex-row">
      {/* Left Panel */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pt-24 lg:items-start lg:justify-center lg:bg-sidebar lg:px-16 lg:pt-0">
        <nav className="absolute top-0 right-0 left-0 flex h-16 items-center justify-between px-6 lg:px-8">
          <Link
            href="/"
            ref={logoGroupRef}
            className="flex items-center gap-1.5 active:scale-98 transition-transform"
            onMouseEnter={() => setLogoHovered(true)}
            onMouseLeave={() => setLogoHovered(false)}
            onTouchStart={() => setLogoHovered(true)}
            onTouchEnd={() => setLogoHovered(false)}
            onTouchCancel={() => setLogoHovered(false)}
          >
            <CuedLogo size={24} interactive trackingRef={logoGroupRef} />
            <span className="text-lg font-[550] tracking-[-0.075em] inline-flex">
              <span>Cue</span>
              <span className="relative inline-flex">
                <AnimatePresence>
                  {logoHovered && (
                    <motion.span
                      className="inline-block -tracking-widest"
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
          <Link
            href="/manifesto"
            className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Manifesto
          </Link>
        </nav>
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <div className="mx-auto mb-8 h-[1.5px] w-[72px] bg-border lg:mx-0" />
          <h1 className="max-w-xl font-serif text-pretty text-4xl tracking-tighter sm:text-[2.75rem] lg:text-5xl">
            Relationships are your compounding asset.
          </h1>
          <p className="mt-6 max-w-md text-pretty text-lg text-muted-foreground">
            A unified inbox that enriches your network and surfaces
            opportunities for you.
          </p>
          <button
            onClick={() => router.push("/sign-up")}
            className="mt-10 inline-flex active:scale-98 items-center justify-between gap-2.5 rounded-full cursor-pointer bg-primary px-6 py-3 text-xl font-[550] text-primary-foreground transition-all hover:bg-primary/90"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <StaggeringText
              hover={isHovered}
              className="[&>span]:inline-block [&>span]:tracking-[-0.07em]"
            >
              Request Access
            </StaggeringText>
            <ArrowRight className="size-5" />
          </button>
        </div>
      </div>

      {/* Right Panel - Card Stack */}
      <div className="mt-16 flex flex-1 items-center justify-center overflow-hidden px-6 pb-24 lg:mt-0 lg:pb-0">
        <DemoCardStack />
      </div>
    </div>
  );
}

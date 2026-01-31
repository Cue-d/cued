"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StaggeringText } from "@cued/ui";

export default function ManifestoPage() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-6 py-24">
      <article className="mx-auto max-w-2xl">
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
          Manifesto
        </h1>

        <div className="mt-12 space-y-8 text-lg leading-relaxed text-muted-foreground">
          <p>
            Relationships are the foundation of everything meaningful in life.
            Yet in our hyper-connected world, we&apos;re paradoxically more
            disconnected than ever.
          </p>

          <p>
            We scatter our conversations across a dozen apps. We forget to reply
            to the people who matter most. We let weeks slip by without reaching
            out to old friends. We miss the follow-up that could have closed the
            deal.
          </p>

          <p>
            <span className="font-medium text-foreground">
              This isn&apos;t a technology problem. It&apos;s a human problem.
            </span>{" "}
            Our tools were built for efficiency, not for relationships. They
            optimize for response time, not for the quality of our connections.
          </p>

          <p>
            We believe there&apos;s a better way. A world where technology works{" "}
            <em>with</em> us to nurture the relationships that matter, not
            against us by fragmenting our attention across platforms.
          </p>

          <p>
            <span className="font-medium text-foreground">
              Cued is built on a simple principle:
            </span>{" "}
            your relationships deserve a single, unified home. One place where
            every conversation lives, where no message falls through the cracks,
            where AI helps you show up for the people who matter.
          </p>

          <p>
            We&apos;re not building another inbox. We&apos;re building the relationship
            layer for your life—a place where staying in touch isn&apos;t a chore,
            but a joy.
          </p>

          <p className="text-foreground">
            If you believe relationships matter, we&apos;d love to have you join us.
          </p>
        </div>

        <div className="mt-36 flex justify-center">
          <Link
            href="/sign-up"
            className="group inline-flex w-full h-22 items-center justify-between rounded-full bg-primary px-8 text-4xl tracking-tighter font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <StaggeringText hover={isHovered} className="[&>span]:inline-block">
              Request Access
            </StaggeringText>
            <ArrowRight className="size-8" />
          </Link>
        </div>
      </article>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StaggeringText } from "../components/staggering-text";

function Footnote({ n }: { n: number }) {
  return (
    <a
      href={`#fn-${n}`}
      id={`ref-${n}`}
      className="text-secondary-foreground/50 text-xs align-super no-underline hover:text-secondary-foreground transition-colors"
    >
      [{n}]
    </a>
  );
}

export default function ManifestoPage() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-sidebar px-6 py-24">
      <article className="mx-auto max-w-[540px]">
        <h1 className="text-4xl tracking-tight font-serif">Manifesto</h1>
        <div className="mt-6 space-y-6 text-[17px] text-pretty leading-relaxed tracking-tight font-[450] text-secondary-foreground/80">
          <p className="text-secondary-foreground font-semibold">
            Your net worth is your network.
          </p>

          <p>
            This isn&apos;t a platitude. 85% of jobs are filled through personal
            connections.
            <Footnote n={1} /> 60% of venture deals come from warm referrals.
            <Footnote n={2} /> Referred hires outperform and outlast every other
            source.
            <Footnote n={3} /> The data is unambiguous:{" "}
            <span className="text-secondary-foreground font-semibold">
              relationships are an unfair advantage.
            </span>
          </p>

          <p>
            But relationships are a living system. They follow the second law of
            thermodynamics—left alone, they decay. Every week you don&apos;t
            reach out, every message you forget to reply to, the connection
            weakens. Long-term growth is not the default. It takes work.
          </p>

          <p>
            The anthropologist Robin Dunbar found that humans can maintain
            roughly 150 stable relationships.
            <Footnote n={4} /> That&apos;s the cognitive ceiling. After that,
            people fall off.{" "}
            <span className="text-secondary-foreground font-semibold">
              Imagine what happens when you meaningfully double that number.
            </span>
          </p>

          <p>
            The math is exponential. More real relationships means more warm
            introductions, more serendipity, more doors that open before you
            knock. Mentors, collaborators, investors, friends—each new
            connection compounds into opportunities that cold outreach never
            could.
          </p>

          <p>
            Consider a recruiter who places 10 candidates a year at $30k per
            placement. If doubling their active network yields just 5 more
            referral-sourced placements, that&apos;s $150k in new revenue. A VC
            partner seeing 20% more warm deal flow closes one extra
            fund-returner per cycle. A real estate agent with 300 real
            relationships instead of 150 turns past clients into a referral
            engine—one extra closing a quarter is $40k+ in commission.{" "}
            <span className="text-secondary-foreground font-semibold">
              The ROI of relationships isn&apos;t linear. It compounds.
            </span>
          </p>

          <p>
            And cold outreach is dying. The internet gave everyone access to
            everyone—cold emails, cold DMs, cold applications. But the flood of
            noise killed it. People retreat to those they already trust.
            Introductions that come warm. Friends who actually show up.{" "}
            <span className="text-secondary-foreground font-semibold">
              Warm connections are more valuable than ever.
            </span>
          </p>

          <p className="text-secondary-foreground font-semibold">
            That&apos;s what we&apos;re building.
          </p>

          <p>
            Cued is a mechanism to expand your Dunbar&apos;s Number. Not by
            adding noise—not by automating messages or treating people like
            leads. We believe fully AI-generated outreach is inhumane.
            Relationships are not workflows. People are not a pipeline.
          </p>

          <p>
            Instead, Cued surfaces the right moment to reach out, across every
            platform where your conversations live. It fights the entropy so
            your relationships compound instead of decay.
          </p>

          <p className="text-secondary-foreground font-semibold">
            The world rewards those who invest in people. We make that
            investment effortless.
          </p>
        </div>

        <div className="flex justify-center mt-32">
          <Link
            href="/sign-up"
            className="group inline-flex w-full h-20 items-center justify-between rounded-full bg-primary px-10 text-4xl font-[550] text-primary-foreground transition-colors hover:bg-primary/90"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <StaggeringText
              hover={isHovered}
              className="[&>span]:inline-block [&>span]:tracking-[-0.07em]"
            >
              Request Access
            </StaggeringText>
            <ArrowRight className="size-8" />
          </Link>
        </div>

        {/* Appendix */}
        <div className="mt-32 pt-8 text-secondary-foreground/50 ">
          <ol className="list-decimal space-y-2 text-xs text-pretty leading-relaxed text-secondary-foreground/50">
            <li id="fn-1">
              70–85% of jobs are filled through networking or personal
              connections. LinkedIn / labor market summaries; Adler, L.
              &ldquo;New Survey Reveals 85% of All Jobs are Filled Via
              Networking.&rdquo;{" "}
              <a href="#ref-1" className="text-secondary-foreground/30">
                &uarr;
              </a>
            </li>
            <li id="fn-2">
              ~60% of closed VC deals (up to 88%) originate from network-based
              referrals. Affinity, &ldquo;How to Increase Venture Capital Deal
              Flow.&rdquo;{" "}
              <a href="#ref-2" className="text-secondary-foreground/30">
                &uarr;
              </a>
            </li>
            <li id="fn-3">
              Referred hires have higher retention and performance than
              non-referred hires. NBER Working Paper No. 25920; SHRM (2016)
              reports ~30% of all hires come from employee referrals despite
              being only 6.9% of applicants.{" "}
              <a href="#ref-3" className="text-secondary-foreground/30">
                &uarr;
              </a>
            </li>
            <li id="fn-4">
              Dunbar, R.I.M. &ldquo;Neocortex size as a constraint on group size
              in primates.&rdquo; Journal of Human Evolution, 1992. Proposes a
              cognitive limit of ~150 stable social relationships based on
              neocortex ratio extrapolation from primates.{" "}
              <a href="#ref-4" className="text-secondary-foreground/30">
                &uarr;
              </a>
            </li>
          </ol>
        </div>
      </article>
    </div>
  );
}

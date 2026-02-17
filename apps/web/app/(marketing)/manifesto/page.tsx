"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StaggeringText } from "../components/staggering-text";

function Divider() {
  return <div className="my-10 h-px w-12 bg-border" />;
}

export default function ManifestoPage() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-sidebar px-6 py-24">
      <article className="mx-auto max-w-[540px]">
        <h1 className="text-4xl tracking-tight font-serif">Manifesto</h1>
        <div className="mt-6 text-[17px] text-pretty leading-relaxed tracking-tight font-[450] text-secondary-foreground/80">

          <p>
            In 1992, anthropologist Robin Dunbar proposed that the human brain
            can maintain roughly 150 stable relationships — real, reciprocal,
            I-know-what&apos;s-going-on-in-your-life relationships. Five people
            you&apos;d call at 3am. Fifteen close friends. Fifty you&apos;d
            invite to dinner. And 150 you&apos;d recognize, trust, and maintain.
            Beyond that, the relationship decays.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            For most of human history, 150 was enough. It isn&apos;t anymore.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            The rise and fall of cold power
          </h2>

          <p className="mt-6">
            The early internet created an era of{" "}
            <span className="text-secondary-foreground font-semibold">
              cold power
            </span>{" "}
            — the ability to reach anyone, anywhere, without introduction.
            LinkedIn made every professional addressable. Cold email became a
            growth strategy. Access <em>was</em> the advantage.
          </p>

          <p className="mt-6">
            Then the flood came. Inboxes overflowed. LinkedIn became a spam
            channel. Every &ldquo;quick question&rdquo; was a pitch. Every
            &ldquo;congrats on the new role&rdquo; was a warm-up to an ask.
          </p>

          <p className="mt-6">
            Now AI has made it trivially cheap to generate
            personalized-sounding outreach at scale. By mid-2026, every channel
            we thought was safe — iMessage, phone calls, email — will be flooded
            with AI-generated messages indistinguishable from real ones. The
            signal-to-noise ratio isn&apos;t declining. It&apos;s collapsing.
          </p>

          <p className="mt-6">
            So humans are doing what they always do when a channel becomes noisy
            — retreating to trust. Hiring managers ask{" "}
            <em>&ldquo;who do you know?&rdquo;</em> VCs rely on warm intros.
            Deals close because someone vouched. The data confirms it:
          </p>

          <ul className="mt-4 space-y-1.5 list-disc pl-5">
            <li>
              <span className="text-secondary-foreground font-semibold">
                70–85% of jobs
              </span>{" "}
              are filled through personal connections
            </li>
            <li>
              <span className="text-secondary-foreground font-semibold">
                30% of hires
              </span>{" "}
              come from referrals — from less than 7% of applicants
            </li>
            <li>
              <span className="text-secondary-foreground font-semibold">
                Up to 88% of closed VC deals
              </span>{" "}
              originate from warm introductions
            </li>
            <li>
              Referred hires have{" "}
              <span className="text-secondary-foreground font-semibold">
                higher retention and performance
              </span>
            </li>
          </ul>

          <p className="mt-6">
            Cold power is dying. Warm power is the new unfair advantage. And no
            tool exists to help you cultivate it.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            Why AI won&apos;t save you
          </h2>

          <p className="mt-6">
            The seductive pitch: let AI handle your relationships. Personalize
            at scale. Send a thousand messages that <em>feel</em> like one.
          </p>

          <p className="mt-6">
            It won&apos;t work — and the reason is biological, not
            technological.
          </p>

          <p className="mt-6">
            The engineer crushing it at Stripe isn&apos;t leaving for a cold DM,
            no matter how well-crafted. She&apos;s leaving because a former
            colleague she trusts says &ldquo;you need to see what we&apos;re
            building.&rdquo; The founder doesn&apos;t close his lead investor
            through an automated sequence. He closes because someone makes the
            intro over dinner.
          </p>

          <p className="mt-6">
            Humans are social primates with 200,000 years of evolution
            optimizing for detecting sincerity. A &ldquo;thinking of you&rdquo;
            from someone who actually knows you will always outperform a perfect
            message from someone who doesn&apos;t. Cialdini&apos;s persuasion
            research confirms it — reciprocity, liking, and social proof depend
            on genuine prior interaction. Dunbar showed each layer of closeness
            requires ~50 hours of shared time. AI can compose the words. It
            cannot invest the time.
          </p>

          <p className="mt-6">
            The market already reflects this. Cold outreach response rates have
            cratered below 2%. Referral-based hires convert at 40%+. Warm-intro
            sales cycles close 50% faster.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            AI will make cold outreach infinitely cheap. That&apos;s precisely
            why it will become infinitely worthless.
          </p>

          <p className="mt-6">
            When everyone can send a perfect cold message, no cold message is
            perfect. The differentiator becomes the one thing AI cannot
            fabricate: a real relationship, built over real time, with real
            context.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            The future belongs to whoever has the best relationships.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            The second law of relationships
          </h2>

          <p className="mt-6">
            Relationships follow the second law of thermodynamics: left alone,
            they tend toward entropy. The college roommate you swore you&apos;d
            stay close with. The founder you met at a conference. The mentor who
            changed your trajectory. Without sustained energy, they cool — not
            from malice, but from the quiet accumulation of missed texts and
            forgotten follow-ups.
          </p>

          <p className="mt-6">
            Granovetter showed that{" "}
            <span className="text-secondary-foreground font-semibold">
              weak ties
            </span>{" "}
            — acquaintances at the edge of your 150 — are disproportionately
            valuable, bridging you to novel information and opportunities your
            inner circle can&apos;t provide. Burt extended this: the advantage
            isn&apos;t network size, it&apos;s your ability to{" "}
            <span className="text-secondary-foreground font-semibold">
              bridge
            </span>{" "}
            unconnected groups.
          </p>

          <p className="mt-6">
            The problem: weak ties decay first. They require the most context to
            maintain and the least emotional urgency to sustain. They dissolve
            quietly, and with them, the opportunities they carried.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            The decay is real. It&apos;s measurable. And it&apos;s accelerating.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            Expanding Dunbar&apos;s Number
          </h2>

          <p className="mt-6">
            Not through superficial tactics. Not through automation. Through
            awareness and intentional action.
          </p>

          <p className="mt-6">
            Dunbar&apos;s Number exists not because we lack the{" "}
            <em>desire</em> to maintain more relationships — but the{" "}
            <em>capacity</em>. We forget. We lose context. We don&apos;t know
            who to reach out to, when, or why. The overhead of tracking 150
            relationships across a dozen platforms exceeds what any brain can
            handle alone.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            What if it didn&apos;t have to?
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            What Cued is
          </h2>

          <p className="mt-6">
            Cued is the infrastructure for your relationship capital.
          </p>

          <p className="mt-6">
            We don&apos;t automate your relationships. We make you{" "}
            <span className="text-secondary-foreground font-semibold">
              aware
            </span>{" "}
            of them. We surface the right person at the right moment — the
            college friend who just joined the company you&apos;re selling to,
            the investor you haven&apos;t spoken to in six months who&apos;d be
            perfect for your next round.
          </p>

          <p className="mt-6">
            We call these{" "}
            <span className="text-secondary-foreground font-semibold">
              cues
            </span>{" "}
            — moments of opportunity that exist in your network but decay
            invisibly without action.
          </p>

          <p className="mt-6">
            Cued builds a living map across every platform where relationships
            live — iMessage, email, LinkedIn, WhatsApp, Slack, Signal, X. Not a
            contact list. Not a CRM. A{" "}
            <span className="text-secondary-foreground font-semibold">
              relationship graph
            </span>{" "}
            that understands context, detects decay, and surfaces the moments
            that matter.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            The action is always yours. The words are always yours. The
            relationship is always yours.
          </p>

          <p className="mt-6">
            We use AI to extend your <em>memory</em>, not replace your{" "}
            <em>voice</em>. A calendar doesn&apos;t attend meetings for you — it
            makes sure you show up. Cued doesn&apos;t maintain relationships for
            you — it makes sure you don&apos;t lose them.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            What Cued is not
          </h2>

          <p className="mt-6">
            <span className="text-secondary-foreground font-semibold">
              Not a unified inbox.
            </span>{" "}
            Seeing everything in one place doesn&apos;t mean you&apos;ll act.
            Context management is a means, not an end.
          </p>

          <p className="mt-6">
            <span className="text-secondary-foreground font-semibold">
              Not an automation platform.
            </span>{" "}
            Relationships are not workflows. Sending AI-generated messages
            signals exactly what the recipient is to you: a row in a
            spreadsheet. If you wouldn&apos;t let a robot speak for you at
            dinner, don&apos;t let one speak for you in someone&apos;s inbox.
          </p>

          <p className="mt-6">
            <span className="text-secondary-foreground font-semibold">
              Not a CRM.
            </span>{" "}
            Relationships are not leads.
          </p>

          <p className="mt-6">
            <span className="text-secondary-foreground font-semibold">
              Not productivity software.
            </span>{" "}
            Not another dashboard. We&apos;re building something that feels like
            having a great memory and the instinct of someone who&apos;s
            naturally good at staying in touch.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            Who Cued is for
          </h2>

          <p className="mt-6">
            The VC who meets 200 people a quarter and loses 190 to entropy. The
            operator whose career was built on relationships but manages them in
            their head. The recruiter who juggles 50 conversations a day but
            can&apos;t remember who to follow up with. The founder whose
            strongest investor came from a coffee chat two years ago.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            If your success compounds through people — Cued is your
            infrastructure.
          </p>

          <Divider />

          <h2 className="text-2xl tracking-tight font-serif text-secondary-foreground">
            The world we&apos;re building
          </h2>

          <p className="mt-6">
            Your network is a living system. Left alone, it decays. Nurtured
            intentionally, it compounds.
          </p>

          <p className="mt-6">
            The internet spent two decades making connections <em>easy</em>.
            It&apos;s time to make them <em>durable</em>.
          </p>

          <p className="mt-6 text-secondary-foreground font-semibold">
            Dunbar gave us the limit. Cued expands it.
          </p>

          <Divider />

          <p className="italic text-secondary-foreground">
            Your net worth is your network. Start compounding.
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
      </article>
    </div>
  );
}

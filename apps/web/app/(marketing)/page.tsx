"use client";

import { DemoCardStack } from "./demo-cards/demo-card-stack";

export default function Home() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-6">
      {/* Hero */}
      <div className="flex flex-col items-center text-center">
        <div className="mx-auto mb-8 w-[72px] h-[1.5px] bg-border" />
        <h1 className="flex items-baseline font-serif text-pretty max-w-xl justify-center gap-[0.2em] text-4xl tracking-tighter sm:text-5xl md:text-5xl">
          Relationships are your compounding asset.
        </h1>
        <p className="mt-8 max-w-md text-pretty text-lg text-muted-foreground">
          A unified inbox that enriches your network and surfaces opportunities
          for you.
        </p>
      </div>

      {/* Interactive Demo Cards */}
      <div className="mt-16 w-full max-w-4xl">
        <DemoCardStack />
      </div>
    </div>
  );
}

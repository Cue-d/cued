"use client";

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
          A unified inbox that enriches your network and surfaces opportunities for you.
        </p>

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

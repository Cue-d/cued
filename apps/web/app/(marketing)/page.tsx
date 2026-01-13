import { Button } from "@prm/ui"

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <main className="max-w-3xl px-8 py-24">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            PRM
          </h1>
          <p className="mt-6 text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Your personal relationship manager. Connect your communications
            across iMessage, Gmail, and Slack.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Button asChild>
              <a href="/sign-in">
                Sign In
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="/sign-up">
                Sign Up
              </a>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

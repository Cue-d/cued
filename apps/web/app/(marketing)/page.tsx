import { Button } from "@prm/ui"
import Link from "next/link"

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <main className="max-w-3xl px-8 py-24">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight">PRM</h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            Your personal relationship manager. Connect your communications
            across iMessage, Gmail, and Slack.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Button render={<Link href="/sign-in" />}>Sign In</Button>
            <Button variant="outline" render={<Link href="/sign-up" />}>
              Sign Up
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

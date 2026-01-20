import Link from "next/link";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";

export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await withAuth();

  if (user) {
    redirect("/inbox");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight">PRM</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/sign-in"
              className="inline-flex h-8 items-center justify-center rounded-md px-2.5 text-sm font-medium hover:bg-muted hover:text-foreground"
            >
              Sign In
            </Link>
            <Link
              href="/sign-up"
              className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
            >
              Get Started
            </Link>
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-6">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-muted-foreground">
            PRM &ndash; Your personal relationship manager
          </p>
        </div>
      </footer>
    </div>
  );
}

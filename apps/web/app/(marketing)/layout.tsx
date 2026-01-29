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
      {/* Header */}
      <header className="absolute top-0 left-0 right-0 z-50">
        <nav className="flex h-16 items-center justify-between px-6 lg:px-8">
          <Link href="/" className="flex items-center">
            <span className="text-lg font-medium tracking-tight">PRM</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/sign-in"
              className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign In
            </Link>
          </div>
        </nav>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col">{children}</main>

      {/* Footer */}
      <footer className="absolute bottom-0 left-0 right-0 z-50">
        <div className="flex h-16 items-center justify-center px-6 lg:px-8">
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} PRM
          </p>
        </div>
      </footer>
    </div>
  );
}

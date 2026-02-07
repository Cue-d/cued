import { Toaster } from "@cued/ui";
import { MarketingHeader } from "./marketing-header";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-background">
      <Toaster />
      <MarketingHeader />

      {/* Main content */}
      <main className="flex flex-1 flex-col">{children}</main>

      {/* Footer */}
      <footer className="mt-auto flex items-center justify-center py-4">
        <p className="text-sm tabular-nums font-medium text-muted-foreground tracking-tight text-center">
          &copy; {new Date().getFullYear()} Cued
        </p>
      </footer>
    </div>
  );
}

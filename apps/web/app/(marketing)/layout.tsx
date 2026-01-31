import { MarketingHeader } from "./marketing-header";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <MarketingHeader />

      {/* Main content */}
      <main className="flex flex-1 flex-col">{children}</main>

      {/* Footer */}
      <footer className="absolute bottom-0 left-0 right-0 z-50">
        <div className="flex h-16 items-center justify-center px-6 lg:px-8">
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Cued
          </p>
        </div>
      </footer>
    </div>
  );
}

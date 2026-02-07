"use client";

import { usePathname } from "next/navigation";
import { Toaster } from "@cued/ui";
import { MarketingHeader } from "./marketing-header";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-background">
      <Toaster />
      {!isHome && <MarketingHeader />}

      {/* Main content */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

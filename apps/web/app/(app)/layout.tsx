import { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-white dark:bg-zinc-950">{children}</div>;
}

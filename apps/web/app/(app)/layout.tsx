import { ReactNode } from "react"
import { AppLayoutClient } from "./_components/app-layout-client"

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppLayoutClient>{children}</AppLayoutClient>
}

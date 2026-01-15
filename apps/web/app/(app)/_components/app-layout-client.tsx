"use client";

import { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@prm/convex";
import { signOut } from "@workos-inc/authkit-nextjs";
import { SidebarProvider, SidebarInset, AppSidebar } from "@prm/ui";

interface AppLayoutClientProps {
  children: ReactNode;
}

export function AppLayoutClient({ children }: AppLayoutClientProps) {
  const currentUser = useQuery(api.users.getCurrentUser);
  const actionCountResult = useQuery(api.actions.getPendingActionCount, {});

  const user = currentUser
    ? {
        name: currentUser.name ?? undefined,
        email: currentUser.email ?? undefined,
      }
    : null;

  const actionCount = actionCountResult?.count ?? 0;

  return (
    <SidebarProvider>
      <AppSidebar user={user} onSignOut={signOut} actionCount={actionCount} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}

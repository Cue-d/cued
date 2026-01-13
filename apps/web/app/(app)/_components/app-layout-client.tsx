"use client";

import { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@prm/convex";
import { signOut } from "@workos-inc/authkit-nextjs";
import { SidebarProvider, SidebarInset, AppSidebar } from "@prm/ui";

export function AppLayoutClient({ children }: { children: ReactNode }) {
  const currentUser = useQuery(api.users.getCurrentUser);

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <SidebarProvider>
      <AppSidebar
        user={
          currentUser
            ? {
                name: currentUser.name || undefined,
                email: currentUser.email || undefined,
              }
            : null
        }
        onSignOut={handleSignOut}
      />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}

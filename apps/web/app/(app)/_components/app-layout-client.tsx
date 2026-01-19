"use client";

import { ReactNode, useEffect, useRef } from "react";
import { signOut } from "@workos-inc/authkit-nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "@prm/convex";
import { SidebarProvider, SidebarInset, AppSidebar, CommandMenu } from "@prm/ui";

interface WorkosProfile {
  email: string;
  firstName?: string;
  lastName?: string;
  profilePictureUrl?: string;
}

interface AppLayoutClientProps {
  children: ReactNode;
  workosProfile?: WorkosProfile;
}

export function AppLayoutClient({
  children,
  workosProfile,
}: AppLayoutClientProps) {
  const userProfile = useQuery(api.users.getProfile);
  const actionCountResult = useQuery(api.actions.getPendingActionCount, {});
  const syncProfile = useMutation(api.users.syncProfile);
  const hasSynced = useRef(false);

  // Sync user profile from WorkOS on first load
  useEffect(() => {
    if (workosProfile && !hasSynced.current) {
      hasSynced.current = true;
      syncProfile({
        email: workosProfile.email,
        firstName: workosProfile.firstName,
        lastName: workosProfile.lastName,
        profilePictureUrl: workosProfile.profilePictureUrl,
      }).catch(console.error);
    }
  }, [workosProfile, syncProfile]);

  const user = userProfile
    ? {
        name: [userProfile.firstName, userProfile.lastName].filter(Boolean).join(" ") || undefined,
        email: userProfile.email ?? undefined,
      }
    : null;

  const actionCount = actionCountResult?.count ?? 0;

  return (
    <SidebarProvider>
      <AppSidebar user={user} onSignOut={signOut} actionCount={actionCount} />
      <SidebarInset>{children}</SidebarInset>
      <CommandMenu />
    </SidebarProvider>
  );
}

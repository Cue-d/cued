"use client";

import { ReactNode, useCallback, useEffect, useRef } from "react";
import { signOut } from "@workos-inc/authkit-nextjs";
import { posthog } from "@/components/PostHogProvider";
import { useQuery, useMutation } from "convex/react";
import { api } from "@cued/convex";
import {
  SidebarProvider,
  SidebarInset,
  AppSidebar,
  CommandMenu,
} from "@cued/ui";

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

  const handleSignOut = useCallback(() => {
    if (process.env.NEXT_PUBLIC_POSTHOG_KEY) posthog.reset();
    signOut();
  }, []);


  return (
    <SidebarProvider>
      <AppSidebar user={user} onSignOut={handleSignOut} />
      <SidebarInset>{children}</SidebarInset>
      <CommandMenu />
    </SidebarProvider>
  );
}

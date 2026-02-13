import { ReactNode } from "react";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { AppLayoutClient } from "./_components/app-layout-client";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await withAuth();

  // Extract profile data from WorkOS user
  const workosProfile = user
    ? {
        email: user.email,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        profilePictureUrl: user.profilePictureUrl ?? undefined,
      }
    : undefined;

  return (
    <AppLayoutClient workosProfile={workosProfile}>
      <PostHogIdentify />
      {children}
    </AppLayoutClient>
  );
}

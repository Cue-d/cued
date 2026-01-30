"use client";

import { ReactNode, useCallback, useEffect, useRef } from "react";
import { signOut } from "@workos-inc/authkit-nextjs";
import { useQuery, useMutation } from "convex/react";
import { api, Id } from "@cued/convex";
import {
  SidebarProvider,
  SidebarInset,
  AppSidebar,
  CommandMenu,
  UndoSendProvider,
  type PendingMessage,
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
  const actionCountResult = useQuery(api.actions.getPendingActionCount, {});
  const syncProfile = useMutation(api.users.syncProfile);
  const hasSynced = useRef(false);

  // Message queue for undo send functionality
  const pendingMessagesResult = useQuery(api.messageQueue.getPendingMessages, {});
  const cancelMessageMutation = useMutation(api.messageQueue.cancelMessage);
  const sendImmediatelyMutation = useMutation(api.messageQueue.sendImmediately);

  const handleCancelMessage = useCallback(
    async (messageId: string) => {
      await cancelMessageMutation({ messageId: messageId as Id<"messageQueue"> });
    },
    [cancelMessageMutation]
  );

  const handleSendNow = useCallback(
    async (messageId: string) => {
      await sendImmediatelyMutation({ messageId: messageId as Id<"messageQueue"> });
    },
    [sendImmediatelyMutation]
  );

  // Transform Convex messages to PendingMessage type for UndoSendProvider
  const pendingMessages: PendingMessage[] = (pendingMessagesResult?.messages ?? []).map((m) => ({
    _id: m._id,
    platform: m.platform,
    recipientHandle: m.recipientHandle,
    recipientContactId: m.recipientContactId,
    text: m.text,
    scheduledFor: m.scheduledFor,
    timeRemainingMs: m.timeRemainingMs,
  }));

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

  const handleSignOut = useCallback(() => {
    signOut();
  }, []);

  return (
    <UndoSendProvider
      pendingMessages={pendingMessages}
      onCancelMessage={handleCancelMessage}
      onSendNow={handleSendNow}
    >
      <SidebarProvider>
        <AppSidebar user={user} onSignOut={handleSignOut} actionCount={actionCount} />
        <SidebarInset>{children}</SidebarInset>
        <CommandMenu />
      </SidebarProvider>
    </UndoSendProvider>
  );
}

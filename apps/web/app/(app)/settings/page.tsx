"use client";

import * as React from "react";
import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  BrainIcon,
  ClockIcon,
  SendIcon,
  WrenchIcon,
  ChevronRightIcon,
  UserIcon,
} from "lucide-react";
import { api } from "@cued/convex";
import { getInitials, formatRelativeTime } from "@cued/shared";
import {
  ThreePanelLayout,
  PanelHeader,
  PanelContent,
  ListItem,
  Avatar,
  AvatarFallback,
  Skeleton,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Card,
  CardContent,
} from "@cued/ui";

const UNDO_DELAY_OPTIONS = [
  { value: 3, label: "3 seconds" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
] as const;

// Settings sections
const SETTINGS_SECTIONS = [
  { id: "memory", label: "Memory Sync", icon: BrainIcon },
  { id: "messages", label: "Messages", icon: SendIcon },
  { id: "account", label: "Account", icon: UserIcon },
  { id: "developer", label: "Developer", icon: WrenchIcon },
] as const;

type SettingSection = typeof SETTINGS_SECTIONS[number]["id"];

function MemorySyncSection() {
  const memoryStats = useQuery(api.memories.getMemoryStatsByContact);
  const processingStatus = useQuery(api.memories.getMemoryProcessingStatus, {
    platform: "imessage",
  });

  const isMemoryLoading =
    memoryStats === undefined || processingStatus === undefined;
  const totalMemories = processingStatus?.totalMemoriesExtracted ?? 0;
  const totalProcessed = processingStatus?.totalMessagesProcessed ?? 0;
  const memoryRows = useMemo(
    () => (memoryStats ?? []).slice(0, 12),
    [memoryStats]
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Memory Sync</h2>
        <p className="text-sm text-muted-foreground mt-1">
          View memories extracted from your conversations
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex size-9 items-center justify-center rounded-md bg-muted">
              <BrainIcon className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">Extraction status</p>
              <p className="text-xs text-muted-foreground">
                Automatically runs after each sync
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border bg-muted/30 p-3">
              {isMemoryLoading ? (
                <Skeleton className="h-6 w-16 mb-1" />
              ) : (
                <div className="text-lg font-semibold">
                  {totalMemories}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Memories extracted
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              {isMemoryLoading ? (
                <Skeleton className="h-6 w-16 mb-1" />
              ) : (
                <div className="text-lg font-semibold">
                  {totalProcessed}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Messages processed
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Recent contacts
            </p>
            {isMemoryLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-md border p-2"
                  >
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 rounded-full" />
                      <div>
                        <Skeleton className="h-3 w-28 mb-1" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                    <Skeleton className="h-4 w-12" />
                  </div>
                ))}
              </div>
            ) : memoryRows.length === 0 ? (
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                No memories extracted yet. Sync messages to get started.
              </div>
            ) : (
              <div className="space-y-2">
                {memoryRows.map((stat) => (
                  <div
                    key={stat.contactId}
                    className="flex items-center justify-between rounded-md border p-2"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback className="text-[10px]">
                          {getInitials(stat.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {stat.displayName}
                        </p>
                        {stat.company ? (
                          <p className="text-xs text-muted-foreground truncate">
                            {stat.company}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {stat.messagesProcessed} messages
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {stat.messagesProcessed}
                      </span>
                      <ClockIcon className="size-3" />
                      {formatRelativeTime(stat.lastExtractedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MessagesSection() {
  const userSettings = useQuery(api.users.getSettings);
  const updateUndoDelay = useMutation(api.users.updateUndoSendDelay);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Messages</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure message sending behavior
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-muted">
              <SendIcon className="size-4 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">Undo send delay</p>
              <p className="text-xs text-muted-foreground">
                Time to cancel a message before it sends
              </p>
            </div>
            <Select
              value={String(userSettings?.undoSendDelaySeconds ?? 30)}
              onValueChange={(value) => {
                updateUndoDelay({ delaySeconds: Number(value) });
              }}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNDO_DELAY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AccountSection() {
  const user = useQuery(api.users.getProfile);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account settings
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <Avatar className="size-12">
              <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                {user?.firstName && user?.lastName
                  ? getInitials(`${user.firstName} ${user.lastName}`)
                  : user?.email?.[0]?.toUpperCase() ?? "U"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {user?.firstName && user?.lastName
                  ? `${user.firstName} ${user.lastName}`
                  : user?.email ?? "User"}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {user?.email ?? ""}
              </p>
            </div>
          </div>
        </CardContent>
        <Separator />
        <CardContent className="p-4">
          <button className="text-sm text-destructive hover:underline">
            Delete account
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

function DeveloperSection() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Developer</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tools for debugging and testing
        </p>
      </div>

      <Link
        href="/settings/debug"
        className="flex items-center justify-between rounded-lg border bg-card p-4 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-muted">
            <WrenchIcon className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">Debug Tools</p>
            <p className="text-xs text-muted-foreground">
              Reset sync data and manage integrations
            </p>
          </div>
        </div>
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </Link>

      {/* Version Info */}
      <div className="pt-4 text-center">
        <p className="text-xs text-muted-foreground">
          Cued v0.1.0 · Made with care
        </p>
      </div>
    </div>
  );
}

function SettingsSectionContent({ section }: { section: SettingSection }) {
  switch (section) {
    case "memory":
      return <MemorySyncSection />;
    case "messages":
      return <MessagesSection />;
    case "account":
      return <AccountSection />;
    case "developer":
      return <DeveloperSection />;
    default:
      return null;
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedSection = (searchParams.get("section") ?? "memory") as SettingSection;

  const handleSectionSelect = React.useCallback(
    (sectionId: SettingSection) => {
      router.push(`/settings?section=${sectionId}`);
    },
    [router]
  );

  return (
    <ThreePanelLayout
      storageKey="settings"
      listHeader={
        <PanelHeader>
          <h2 className="text-lg font-semibold">Settings</h2>
        </PanelHeader>
      }
      listPanel={
        <PanelContent>
          <div className="p-2 space-y-1">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <ListItem
                  key={section.id}
                  selected={selectedSection === section.id}
                  onClick={() => handleSectionSelect(section.id)}
                >
                  <div className="flex items-center gap-3">
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{section.label}</span>
                  </div>
                </ListItem>
              );
            })}
          </div>
        </PanelContent>
      }
      detailPanel={
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl">
            <SettingsSectionContent section={selectedSection} />
          </div>
        </div>
      }
    />
  );
}

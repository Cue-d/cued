"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { BrainIcon, ClockIcon, SendIcon, WrenchIcon, ChevronRightIcon } from "lucide-react";
import { api } from "@prm/convex";
import { getInitials } from "@prm/shared";
import {
  Avatar,
  AvatarFallback,
  Skeleton,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@prm/ui";

const UNDO_DELAY_OPTIONS = [
  { value: 3, label: "3 seconds" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
] as const;

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SettingsPage() {
  const user = useQuery(api.users.getProfile);
  const userSettings = useQuery(api.users.getSettings);
  const updateUndoDelay = useMutation(api.users.updateUndoSendDelay);
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
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center border-b px-6">
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          {/* Memory Sync Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">
                Memory sync
              </h2>
              <p className="text-sm text-muted-foreground">
                View memories extracted from your conversations
              </p>
            </div>

            <div className="rounded-lg border bg-card">
              <div className="p-4">
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
              </div>
            </div>
          </section>

          {/* Messages Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">Messages</h2>
              <p className="text-sm text-muted-foreground">
                Configure message sending behavior
              </p>
            </div>

            <div className="rounded-lg border bg-card">
              <div className="p-4">
                <div className="flex items-center gap-3 mb-4">
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
              </div>
            </div>
          </section>

          {/* Account Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">Account</h2>
              <p className="text-sm text-muted-foreground">
                Manage your account settings
              </p>
            </div>

            <div className="rounded-lg border bg-card">
              <div className="flex items-center gap-4 p-4">
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
              <Separator />
              <div className="p-4">
                <button className="text-sm text-destructive hover:underline">
                  Delete account
                </button>
              </div>
            </div>
          </section>

          {/* Debug Tools Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">Developer</h2>
              <p className="text-sm text-muted-foreground">
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
          </section>

          {/* Version Info */}
          <div className="pb-6 text-center">
            <p className="text-xs text-muted-foreground">
              PRM v0.1.0 · Made with care
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

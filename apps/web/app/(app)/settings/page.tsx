"use client";

import { useQuery } from "convex/react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { api } from "@prm/convex";
import { Avatar, AvatarFallback, Skeleton, Separator, Switch } from "@prm/ui";
import {
  SunIcon,
  MoonIcon,
  MonitorIcon,
  BellIcon,
  ShieldIcon,
  DatabaseIcon,
  PaletteIcon,
  BrainIcon,
  ClockIcon,
} from "lucide-react";

// SSR-safe mounted detection via useSyncExternalStore
const noop = (): void => {};
function useIsMounted(): boolean {
  return useSyncExternalStore(
    () => noop,
    () => true,
    () => false
  );
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

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
  const { theme, setTheme } = useTheme();
  const mounted = useIsMounted();
  const memoryStats = useQuery(api.memories.getMemoryStatsByContact);
  const processingStatus = useQuery(api.memories.getMemoryProcessingStatus, {
    platform: "imessage",
  });

  const selectedTheme = mounted ? theme : null;
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

          {/* Appearance Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">
                Appearance
              </h2>
              <p className="text-sm text-muted-foreground">
                Customize how PRM looks on your device
              </p>
            </div>

            <div className="rounded-lg border bg-card">
              <div className="p-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex size-9 items-center justify-center rounded-md bg-muted">
                    <PaletteIcon className="size-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Theme</p>
                    <p className="text-xs text-muted-foreground">
                      Select your preferred color scheme
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setTheme("light")}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors ${
                      selectedTheme === "light"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex size-10 items-center justify-center rounded-md bg-white border shadow-sm">
                      <SunIcon className="size-5 text-amber-500" />
                    </div>
                    <span className="text-xs font-medium">Light</span>
                  </button>

                  <button
                    onClick={() => setTheme("dark")}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors ${
                      selectedTheme === "dark"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex size-10 items-center justify-center rounded-md bg-zinc-900 border border-zinc-700 shadow-sm">
                      <MoonIcon className="size-5 text-blue-400" />
                    </div>
                    <span className="text-xs font-medium">Dark</span>
                  </button>

                  <button
                    onClick={() => setTheme("system")}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors ${
                      selectedTheme === "system"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex size-10 items-center justify-center rounded-md bg-linear-to-br from-white to-zinc-900 border shadow-sm">
                      <MonitorIcon className="size-5 text-zinc-500" />
                    </div>
                    <span className="text-xs font-medium">System</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Notifications Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">
                Notifications
              </h2>
              <p className="text-sm text-muted-foreground">
                Configure how you receive alerts
              </p>
            </div>

            <div className="rounded-lg border bg-card divide-y">
              <SettingsRow
                icon={<BellIcon className="size-4" />}
                title="Push notifications"
                description="Receive notifications for new messages"
              >
                <Switch defaultChecked />
              </SettingsRow>
              <SettingsRow
                icon={<BellIcon className="size-4" />}
                title="Email digest"
                description="Weekly summary of your conversations"
              >
                <Switch />
              </SettingsRow>
            </div>
          </section>

          {/* Privacy Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">Privacy</h2>
              <p className="text-sm text-muted-foreground">
                Manage your data and privacy settings
              </p>
            </div>

            <div className="rounded-lg border bg-card divide-y">
              <SettingsRow
                icon={<ShieldIcon className="size-4" />}
                title="Memory extraction"
                description="Allow AI to extract facts from messages"
              >
                <Switch defaultChecked />
              </SettingsRow>
              <SettingsRow
                icon={<DatabaseIcon className="size-4" />}
                title="Data retention"
                description="Keep message history indefinitely"
              >
                <Switch defaultChecked />
              </SettingsRow>
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
                    U
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">User</p>
                  <p className="text-xs text-muted-foreground truncate">
                    Signed in via WorkOS
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

function SettingsRow({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

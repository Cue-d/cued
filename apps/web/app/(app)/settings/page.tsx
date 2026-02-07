"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  SendIcon,
  WrenchIcon,
  ChevronRightIcon,
  UserIcon,
} from "lucide-react";
import { api } from "@cued/convex";
import { getInitials } from "@cued/shared";
import {
  ThreePanelLayout,
  PanelHeader,
  PanelContent,
  ListItem,
  Avatar,
  AvatarFallback,
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
  { id: "messages", label: "Messages", icon: SendIcon },
  { id: "account", label: "Account", icon: UserIcon },
  { id: "developer", label: "Developer", icon: WrenchIcon },
] as const;

type SettingSection = typeof SETTINGS_SECTIONS[number]["id"];

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
  const selectedSection = (searchParams.get("section") ?? "messages") as SettingSection;

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

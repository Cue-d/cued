"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { WrenchIcon, ChevronRightIcon, UserIcon } from "lucide-react";
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
  Card,
  CardContent,
} from "@cued/ui";

// Settings sections
const SETTINGS_SECTIONS = [
  { id: "account", label: "Account", icon: UserIcon },
  { id: "developer", label: "Developer", icon: WrenchIcon },
] as const;

type SettingSection = typeof SETTINGS_SECTIONS[number]["id"];

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
  const sectionParam = searchParams.get("section");
  const selectedSection = SETTINGS_SECTIONS.some((section) => section.id === sectionParam)
    ? (sectionParam as SettingSection)
    : "account";

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

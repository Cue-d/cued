"use client";

import {
  CheckCircle2Icon,
  XCircleIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  UsersIcon,
} from "lucide-react";
import { formatRelativeTime } from "@prm/shared";
import { Button, Skeleton } from "@prm/ui";

export interface SocialIntegrationConfig {
  id: "linkedin";
  name: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}

interface SocialConnectionStatusProps {
  isConnected: boolean;
  isLoading: boolean;
}

function SocialConnectionStatus({ isConnected, isLoading }: SocialConnectionStatusProps) {
  if (isLoading) {
    return <Skeleton className="h-4 w-20" />;
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-1.5 text-green-600">
        <CheckCircle2Icon className="size-4" />
        <span className="text-xs font-medium">Logged In</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <XCircleIcon className="size-4" />
      <span className="text-xs">Not logged in</span>
    </div>
  );
}

interface SocialActionButtonProps {
  isConnected: boolean;
  isLoading: boolean;
}

function SocialActionButton({ isConnected, isLoading }: SocialActionButtonProps) {
  if (isLoading) {
    return <Skeleton className="h-9 w-24" />;
  }

  if (isConnected) {
    return (
      <Button variant="outline" size="sm" disabled>
        <RefreshCwIcon className="size-4 mr-2" />
        Scrape Now
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" disabled>
      <ExternalLinkIcon className="size-4 mr-2" />
      Open Login
    </Button>
  );
}

interface SocialIntegrationCardProps {
  config: SocialIntegrationConfig;
  isConnected: boolean;
  isLoading: boolean;
  lastSyncAt: number | null;
  totalContactsSynced: number;
}

export function SocialIntegrationCard({
  config,
  isConnected,
  isLoading,
  lastSyncAt,
  totalContactsSynced,
}: SocialIntegrationCardProps) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <div
            className={`flex size-12 items-center justify-center rounded-lg bg-muted ${config.color}`}
          >
            {config.icon}
          </div>
          <div>
            <h3 className="text-sm font-medium">{config.name}</h3>
            <p className="text-xs text-muted-foreground">{config.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SocialConnectionStatus isConnected={isConnected} isLoading={isLoading} />
          <SocialActionButton isConnected={isConnected} isLoading={isLoading} />
        </div>
      </div>

      {/* Stats section */}
      {(isConnected || totalContactsSynced > 0) && (
        <div className="border-t px-4 py-2 flex items-center gap-4">
          {totalContactsSynced > 0 && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <UsersIcon className="size-3.5" />
              <span className="text-xs">{totalContactsSynced} connections</span>
            </div>
          )}
          {lastSyncAt && (
            <span className="text-xs text-muted-foreground">
              Last scraped {formatRelativeTime(lastSyncAt)}
            </span>
          )}
        </div>
      )}

      {/* Desktop app required notice */}
      <div className="border-t px-4 py-2 bg-muted/30">
        <p className="text-xs text-muted-foreground">
          💡 Requires the PRM desktop app to scrape social connections
        </p>
      </div>
    </div>
  );
}

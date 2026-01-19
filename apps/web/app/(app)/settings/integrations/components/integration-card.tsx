"use client";

import {
  CheckCircle2Icon,
  XCircleIcon,
  RefreshCwIcon,
  LinkIcon,
} from "lucide-react";
import { formatRelativeTime } from "@prm/shared";
import { Button, Skeleton } from "@prm/ui";

export type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter";

export interface IntegrationConfig {
  id: Platform;
  name: string;
  description: string;
  icon: React.ReactNode;
  nangoIntegrationId: string | null; // null = not using Nango (iMessage uses Electron)
  color: string;
}

interface ConnectionStatusProps {
  isConnected: boolean;
  isLoading: boolean;
}

export function ConnectionStatus({ isConnected, isLoading }: ConnectionStatusProps) {
  if (isLoading) {
    return <Skeleton className="h-4 w-20" />;
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-1.5 text-green-600">
        <CheckCircle2Icon className="size-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <XCircleIcon className="size-4" />
      <span className="text-xs">Not connected</span>
    </div>
  );
}

interface OAuthButtonProps {
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isLoading: boolean;
  hasNangoIntegration: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function OAuthButton({
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  hasNangoIntegration,
  onConnect,
  onDisconnect,
}: OAuthButtonProps) {
  if (isLoading) {
    return <Skeleton className="h-9 w-24" />;
  }

  if (isConnected && hasNangoIntegration) {
    return (
      <Button variant="outline" size="sm" onClick={onDisconnect} disabled={isDisconnecting}>
        {isDisconnecting ? <RefreshCwIcon className="size-4 animate-spin" /> : "Disconnect"}
      </Button>
    );
  }

  if (!isConnected) {
    if (hasNangoIntegration) {
      return (
        <Button variant="default" size="sm" onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? (
            <RefreshCwIcon className="size-4 animate-spin mr-2" />
          ) : (
            <LinkIcon className="size-4 mr-2" />
          )}
          Connect
        </Button>
      );
    }

    return (
      <Button variant="outline" size="sm" disabled>
        Desktop App Required
      </Button>
    );
  }

  return null;
}

interface IntegrationCardProps {
  config: IntegrationConfig;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isLoading: boolean;
  lastSyncAt: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function IntegrationCard({
  config,
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  lastSyncAt,
  onConnect,
  onDisconnect,
}: IntegrationCardProps) {
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
          <ConnectionStatus isConnected={isConnected} isLoading={isLoading} />
          <OAuthButton
            isConnected={isConnected}
            isConnecting={isConnecting}
            isDisconnecting={isDisconnecting}
            isLoading={isLoading}
            hasNangoIntegration={config.nangoIntegrationId !== null}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        </div>
      </div>

      {isConnected && lastSyncAt && (
        <div className="border-t px-4 py-2">
          <p className="text-xs text-muted-foreground">
            Last synced {formatRelativeTime(lastSyncAt)}
          </p>
        </div>
      )}
    </div>
  );
}
